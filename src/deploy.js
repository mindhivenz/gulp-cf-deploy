import CloudFormation from 'aws-sdk/clients/cloudformation'
import through2 from 'through2'
import { PluginError, log, colors } from 'gulp-util'
import fromPairs from 'lodash/fromPairs'
import toPairs from 'lodash/toPairs'
import takeWhile from 'lodash/takeWhile'
import startsWith from 'lodash/startsWith'
import endsWith from 'lodash/endsWith'

/* eslint-disable no-await-in-loop */

class Err extends PluginError {
  constructor(message) {
    super('cf-deploy', message, { showProperties: typeof message === 'object' })
  }
}

const isCompleted = state => ! endsWith(state.StackStatus, '_IN_PROGRESS')

// TODO: show good errors
// TODO: document shorthand of just stack name
// TODO: document parameters
// TODO: document delete on failure for create
// TODO: document return json (changed file extension) and data
// TODO: document examples of omitting secrets and splitting

export default (
  serviceOptions,
  stackNameOrOptions,
  parameters = {},
) =>
  through2.obj(async (file, enc, done) => {
    const stackOptions = typeof stackNameOrOptions === 'string' ?
      { StackName: stackNameOrOptions }
      : stackNameOrOptions

    const deploy = async () => {
      if (file.isNull()) {
        return file
      }
      if (! file.isBuffer()) {
        throw new Err('Can only handle buffered files')
      }
      const StackName = stackOptions.StackName || file.stem
      const cfn = new CloudFormation({
        apiVersion: '2010-05-15',
        ...serviceOptions,
      })

      const logFailures = async ({ StackId }) => {
        const eventsResult = await cfn.describeStackEvents({ StackName: StackId }).promise()
        takeWhile(
          eventsResult.StackEvents,
          e => ! (
            e.PhysicalResourceId === StackId &&
            (e.ResourceStatus === 'CREATE_IN_PROGRESS' || e.ResourceStatus === 'UPDATE_IN_PROGRESS')
          )
        )
          .filter(e => endsWith(e.ResourceStatus, 'FAILED'))
          .reverse()
          .forEach(e => log(
            `${StackName}.${e.LogicalResourceId}:`,
            colors.dim(`(${e.ResourceType})`),
            colors.red(e.ResourceStatusReason || e.ResourceStatus),
          ))
        log(
          'See full details at:',
          colors.blue.underline(`https://${serviceOptions.region}.console.aws.amazon.com/cloudformation/home?region=${serviceOptions.region}#/stack/detail?stackId=${encodeURIComponent(StackId)}`),
        )
      }

      const completedState = async ({ StackId, reportFailures }) => {
        let haveReportedFailures = false
        let state
        let delaySeconds = 2
        for (;;) {
          const describeResult = await cfn.describeStacks({ StackName: StackId }).promise()
          state = describeResult.Stacks[0]
          const completed = isCompleted(state)
          const status = state.StackStatus
          log(`${StackName}: ${status}`, completed ? '' : colors.dim(`checking again in ${delaySeconds}s...`))
          if (reportFailures && ! haveReportedFailures &&
              (startsWith(status, 'ROLLBACK') || startsWith(status, 'DELETE'))) {
            logFailures({ StackId })
            haveReportedFailures = true
          }
          if (completed) {
            return state
          }
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000))  // eslint-disable-line
          delaySeconds = Math.min(delaySeconds * 2, 60)
        }
      }

      let initialState
      try {
        const describeResult = await cfn.describeStacks({ StackName }).promise()
        initialState = describeResult.Stacks[0]
      } catch (e) {
        if (e.code !== 'ValidationError') {
          throw e
        }
      }
      if (initialState) {
        if (! isCompleted(initialState)) {
          log(`${StackName}: waiting for previous operation to complete`)
          initialState = await completedState({ StackId: initialState.StackId })
          log(`${StackName}: starting deployment`)
        }
      } else {
        log(`${StackName}: creating new stack`)
      }
      const updating = initialState != null
      const deployParams = {
        ...(updating ? {} : { OnFailure: 'DELETE' }),
        ...stackOptions,
        Parameters: [
          ...(stackOptions.Parameters || []),
          ...toPairs(parameters).map(([k, v]) => ({
            ParameterKey: k,
            ParameterValue: v,
          })),
        ],
        StackName,
        TemplateBody: file.contents.toString(enc),
      }
      let resultState
      try {
        const deployResult = await cfn[updating ? 'updateStack' : 'createStack'](deployParams).promise()
        resultState = await completedState({ StackId: deployResult.StackId, reportFailures: true })
      } catch (e) {
        if (updating && e.code === 'ValidationError' && e.message === 'No updates are to be performed.') {
          // CloudFormation will only update if *resources* will change, for example: changes to Outputs don't count
          resultState = initialState
        } else {
          throw e
        }
      }
      if (resultState.StackStatus !== 'UPDATE_COMPLETE' && resultState.StackStatus !== 'CREATE_COMPLETE') {
        throw new Err(`Deploying ${StackName} failed (${resultState.StackStatusReason || resultState.StackStatus})`)
      }
      const output = fromPairs(resultState.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]))
      const outputFile = file.clone({ contents: false })
      outputFile.contents = new Buffer(JSON.stringify(output), 'utf8')
      outputFile.data = output
      outputFile.stem += '.outputs'
      outputFile.extname = 'json'
      return outputFile
    }

    try {
      done(null, await deploy())
    } catch (e) {
      if (e instanceof PluginError) {
        done(e)
      } else {
        done(new Err(e))
      }
    }
  })
