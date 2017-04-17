# Deploy CloudFormation stacks in Gulp 

Does what it says on the can. 

## Why this package? 

The headline benefit over other packages is the surfacing of stack errors:
![Example console error output](https://s3.amazonaws.com/mindhive-package-media/gulp-cf-deploy/error-output-example.png)

Other benefits:

- Errors are displayed ASAP, so you can get to fixing them while the rollback completes
- A URL is provided direct to the stack details in the AWS console
- Parameters can be passed as a hash / plain object (rather than in CloudFormation's verbose format)
- Waits for the stack to be deployed before finishing, so tasks in series can rely on the resources being available
- But does not wait for cleanup of old resources, which should not impact following tasks 
- Keeps you updated while waiting for the deployment to complete
- Pipes the outputs of the stack as simplified JSON through the Gulp stream so you can save the outputs or process 
	them further 
- Defaults to deleting a failed stack creation rather than the CloudFormation default of 'rollback' which then has 
	to be manually deleted to try again (however, even when the delete has completed the full details of the 
	failed stack are still available at the console URL)

## Install

`yarn add --dev gulp-cf-deploy`

Or if you're still in npm world: `npm install --save-dev gulp-cf-deploy`

## API
  
```js
import cfDeploy from 'gulp-cf-deploy'

gulp.task('deploy:aws', () =>
  gulp.src('resources.yaml')
    .pipe(cfDeploy(
      awsServiceOptions,
      stackNameOrOptions,
      parameters,
    ))
    .pipe(gulp.dest('build'))
)
```  

Will deploy (create or update) the CloudFormation stack defined in `resources.yaml` 
and save it's outputs as `build/resources.json`

`awsServiceOptions`: passed to [`new AWS.CloudFormation()`](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudFormation.html#constructor-property).
Provide your AWS credentials (if not already set in `AWS.config`) and `region`.
 
`stackNameOrOptions`: passed to [`createStack()`](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudFormation.html#createStack-property) 
or [`updateStack()`](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudFormation.html#updateStack-property).
Often all that's needed is the `StackName` in which case you can just pass the name as a string.
In addition: 
     
- `StackName`: defaulted to the source file's 'stem', in the example above the stack will be named `resources`
- `Parameters`: will be supplemented with the 3rd argument `parameters` 
- `TemplateBody`: is pulled from the source file's content
- `OnFailure`: set to `DELETE` when creating a stack, otherwise the stack needs to be manually deleted to try again 
	(even when deleted the stack can be inspected in the AWS Console for 30 days)   

`parameters`: a hash / plain object of parameters that is merged into `Parameters` (if any) of `stackNameOrOptions`.
	For example: `{ Foo: 123, ... }` becomes `[{ ParameterKey: 'Foo', ParameterValue: 123 }, ...]`	  

Output Vinyl file: The `Outputs` of the stack is simplified into a hash / plain object. 
 	For example `[{ OutputKey: 'Foo', OutputValue: 123 }, ...]` becomes `{ Foo: 123, ... }`.
	The stream output is a file with the same properties as the source file expect:

- `contents`: JSON of the simplified outputs, pipe through `gulp-json-editor` to easily modify 
- `data`: the simplified outputs object
- `extname`: extension is set to `json` 
- Name is unchanged: pipe through `gulp-rename` if you want to change it 

## Post-processing example
 
If you are creating IAM access keys then there are a couple of considerations.
 
1. CloudFormation will only output the SecretAccessKey when the key is first created (or regenerated)
2. When doing anything with IAM users you need to specify so in the stack options
 
```yaml
...
Resources:
  fooBucket:
    Type: "AWS::S3::Bucket"
    Properties:
      BucketName: "bucket-of-foo"
  bobUser:
    Type: "AWS::IAM::User"
    Properties:
      Policies: ...
  bobAccessKey:
    Type: "AWS::IAM::AccessKey"
    Properties:
      Serial: 1
      UserName: !Ref bobUser
Outputs:
  fooBucketArn:
    Value: !Sub "arn:aws:s3:::${fooBucket}"
  bobAccessKey:
    Value: !Ref bobAccessKey
  bobSecretKey:
    Value: !GetAtt bobAccessKey.SecretAccessKey
```

CloudFormation will output `fooBucketArn` and `bobAccessKey` each deployment. 
But `bobSecretKey` will only be output when the keys are first created, or regenerated 
(for example, if the `Serial` was changed). Also, for security, you would want to be managing
you secret and access keys separately from other resource information (such as `fooBucketArn`).

You can handle this as follows:

```js
import AWS from 'aws-sdk/global'
import gulp from 'gulp'
import clone from 'gulp-clone'
import filter from 'gulp-filter'
import rename from 'gulp-rename'
import streamToPromise from 'stream-to-promise'
import jsonEditor from 'gulp-json-editor'
import omitBy from 'lodash/omitBy'

const region = 'ap-southeast-2' 
gulp.task('deploy:aws', () => {
  const cfOutput = gulp.src('deploy/resources.yaml')
    .pipe(cfDeploy(
      {
        credentials: new AWS.Config().credentials,
        region,
      },
      {
        Capabilities: ['CAPABILITY_IAM'],  // Required because we are creating a user
        StackName: `project-resources`,
      },
    ))
  const secrets = cfOutput
    .pipe(clone())
    .pipe(filter(file => file.data.bobSecretKey))  // Only perform if secret key was output
    .pipe(jsonEditor(resources => ({
      accessKeyId: resources.bobAccessKey,
      secretAccessKey: resources.bobSecretKey,
    })))
    .pipe(rename('bob-credentials.json'))
    .pipe(gulp.dest('secrets', { mode: 0o600 }))
  const resources = cfOutput
    .pipe(jsonEditor(resources => ({
      ...omitBy(resources, (v, k) => k.endsWith('Key')),
      region,
    })))
    .pipe(gulp.dest('build'))  // No need to rename, will be resources.json
  return Promise.all([secrets, resources].map(streamToPromise))
})
```
