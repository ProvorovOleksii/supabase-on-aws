import * as amplify from '@aws-cdk/aws-amplify-alpha';
import { GitHubSourceCodeProvider } from '@aws-cdk/aws-amplify-alpha';
import * as cdk from 'aws-cdk-lib';
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface SupabaseStudioProps {
  sourceBranch?: string;
  appRoot?: string;
  supabaseUrl: string;
  dbSecret: ISecret;
  anonKey: StringParameter;
  serviceRoleKey: StringParameter;
}

export class SupabaseStudio extends Construct {
  /** App in Amplify Hosting. It is a collection of branches. */
  readonly app: amplify.App;
  /** Production branch */
  readonly prodBranch: amplify.Branch;
  /** URL of production branch */
  readonly prodBranchUrl: string;

  /** Next.js app on Amplify Hosting */
  constructor(scope: Construct, id: string, props: SupabaseStudioProps) {
    super(scope, id);

    // public.ecr.aws/sam/build-nodejs18.x:latest - old
    const buildImage = 'public.ecr.aws/sam/build-nodejs22.x:1.140.0-20250605234713';
    const appRoot = 'apps/studio';
    const { supabaseUrl, dbSecret, anonKey, serviceRoleKey } = props;

    /** GitHub source for Amplify Hosting */
    const gitHubProvider = new GitHubSourceCodeProvider({
      owner: 'ProvorovOleksii',
      repository: 'supabase',
      oauthToken: cdk.SecretValue.secretsManager('github-token', {
        jsonField: 'token',
      }),
    });

    /** IAM Role for SSR app logging */
    const role = new iam.Role(this, 'Role', {
      description: 'The service role that will be used by AWS Amplify for SSR app logging.',
      path: '/service-role/',
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
    });

    // Allow the role to access Secret and Parameter
    dbSecret.grantRead(role);
    anonKey.grantRead(role);
    serviceRoleKey.grantRead(role);

    /** BuildSpec for Amplify Hosting */
    const buildSpec = BuildSpec.fromObjectToYaml({
      version: 1,
      applications: [{
        appRoot,
        frontend: {
          phases: {
            preBuild: {
              commands: [
                'echo POSTGRES_PASSWORD=$(aws secretsmanager get-secret-value --secret-id $DB_SECRET_ARN --query SecretString | jq -r . | jq -r .password) >> .env.production',
                'echo SUPABASE_ANON_KEY=$(aws ssm get-parameter --region $SUPABASE_REGION --name $ANON_KEY_NAME --query Parameter.Value) >> .env.production',
                'echo SUPABASE_SERVICE_KEY=$(aws ssm get-parameter --region $SUPABASE_REGION --name $SERVICE_KEY_NAME --query Parameter.Value) >> .env.production',
                'env | grep -e STUDIO_PG_META_URL >> .env.production',
                'env | grep -e SUPABASE_ >> .env.production',
                'env | grep -e NEXT_PUBLIC_ >> .env.production',
                'cd ../',
                "export NODE_OPTIONS='--max-old-space-size=12000'",
                'corepack enable',
                'corepack prepare pnpm@latest --activate',
                'pnpm install --config.ignore-engines=true',
              ],
            },
            build: {
              commands: [
                'pnpm exec turbo run build --filter=studio...',
                'pnpm install --prod',
              ],
            },
            // postBuild: {
            //   commands: [
            //     `rsync -av --ignore-existing $(find .next/standalone -maxdepth 2 -type d -name "${appRoot}")/ .next/standalone/`, // check
            //     'cp .env .env.production .next/standalone/',
            //     'rsync -av --ignore-existing public/ .next/standalone/public/',
            //     'rsync -av --ignore-existing .next/static/ .next/standalone/.next/static/',
            //   ],
            // },
          },
          artifacts: {
            baseDirectory: '.next/standalone',
            files: ['**/*'],
          },
          cache: {
            paths: [
              'node_modules/**/*',
            ],
          },
        },
      }],
    });

    this.app = new amplify.App(this, 'App', {
      appName: this.node.path.replace(/\//g, ''),
      role,
      sourceCodeProvider: gitHubProvider,
      buildSpec,
      environmentVariables: {
        // for Amplify Hosting Build
        NODE_OPTIONS: '--max-old-space-size=12000',
        AMPLIFY_DIFF_DEPLOY: 'false',
        _CUSTOM_IMAGE: buildImage,
        // for Supabase
        STUDIO_PG_META_URL: `${supabaseUrl}/pg`,
        SUPABASE_URL: `${supabaseUrl}`,
        SUPABASE_PUBLIC_URL: `${supabaseUrl}`,
        SUPABASE_REGION: serviceRoleKey.env.region,
        DB_SECRET_ARN: dbSecret.secretArn,
        ANON_KEY_NAME: anonKey.parameterName,
        SERVICE_KEY_NAME: serviceRoleKey.parameterName,
        AMPLIFY_MONOREPO_APP_ROOT: appRoot,
      },
      customRules: [{ source: '/<*>', target: '/index.html', status: amplify.RedirectStatus.NOT_FOUND_REWRITE }],
    });

    /** SSR v2 */
    (this.app.node.defaultChild as cdk.CfnResource).addPropertyOverride('Platform', 'WEB_COMPUTE');

    this.prodBranch = this.app.addBranch('ProdBranch', {
      branchName: 'master',
      stage: 'PRODUCTION',
      autoBuild: true,
      environmentVariables: {
        NEXT_PUBLIC_SITE_URL: `https://main.${this.app.appId}.amplifyapp.com`,
        AMPLIFY_MONOREPO_APP_ROOT: appRoot,
      },
    });
    this.prodBranch.addEnvironment('AMPLIFY_MONOREPO_APP_ROOT', appRoot);
    (this.prodBranch.node.defaultChild as cdk.CfnResource).addPropertyOverride('Framework', 'Next.js - SSR');

    // repoImportJob.node.addDependency(this.prodBranch.node.defaultChild!);

    /** IAM Policy for SSR app logging */
    const amplifySSRLoggingPolicy = new iam.Policy(this, 'AmplifySSRLoggingPolicy', {
      policyName: `AmplifySSRLoggingPolicy-${this.app.appId}`,
      statements: [
        new iam.PolicyStatement({
          sid: 'PushLogs',
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/amplify/${this.app.appId}:log-stream:*`],
        }),
        new iam.PolicyStatement({
          sid: 'CreateLogGroup',
          actions: ['logs:CreateLogGroup'],
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/amplify/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DescribeLogGroups',
          actions: ['logs:DescribeLogGroups'],
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`],
        }),
      ],
    });
    amplifySSRLoggingPolicy.attachToRole(role);

    this.prodBranchUrl = `https://${this.prodBranch.branchName}.${this.app.defaultDomain}`;
  }

}
