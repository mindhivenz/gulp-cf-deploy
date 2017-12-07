import CloudFormation from 'aws-sdk/clients/cloudformation'
import through2 from 'through2'
import { PluginError, log, colors } from 'gulp-util'
import fromPairs from 'lodash/fromPairs'
import toPairs from 'lodash/toPairs'
import takeWhile from 'lodash/takeWhile'
import startsWith from 'lodash/startsWith'
import endsWith from 'lodash/endsWith'
import includes from 'lodash/includes'


class Err extends PluginError {
  constructor(message) {
    super('cf-deploy', message, { showProperties: typeof message === 'object' })
  }
}

const isInProgress = state =>
  endsWith(state.StackStatus, '_IN_PROGRESS')

const isCleanupInProgress = state =>
  endsWith(state.StackStatus, '_CLEANUP_IN_PROGRESS')

const isInitialStackEvent = (event, StackId) =>
  event.PhysicalResourceId === StackId &&
  ['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS'].some(s => s === event.ResourceStatus)

const isFailedStackEvent = event =>
  endsWith(event.ResourceStatus, 'FAILED')

const stackStateIndicatesFailure = state =>
  ['ROLLBACK', 'DELETE', 'FAILED'].some(s => includes(state.StackStatus, s))

const isDeployComplete = state =>
  includes(state.StackStatus, '_COMPLETE') && ['CREATE_', 'UPDATE_'].some(s => startsWith(state.StackStatus, s))

const simplifiedOutput = state =>
  fromPairs(state.Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]))


export default (
  serviceOptions = {},
  stackNameOrOptions,
  parameters = {},
) =>
  through2.obj(async (file, enc, done) => {
    const stackOptions = typeof stackNameOrOptions === 'string' ?
      { StackName: stackNameOrOptions }
      : (stackNameOrOptions || {})

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

      const retrieveStackEvents = async ({ StackId }) => {
        const eventsResult = await cfn.describeStackEvents({ StackName: StackId }).promise()
        return takeWhile(eventsResult.StackEvents, e => ! isInitialStackEvent(e, StackId))
          .reverse()  // Change to chronological order
      }

      const logFailures = (stackEvents) => {
        stackEvents
          .filter(e => isFailedStackEvent(e))
          .forEach(e => log(
            `${StackName}.${e.LogicalResourceId}:`,
            colors.dim(`(${e.ResourceStatus})`),
            colors.red(e.ResourceStatusReason || e.ResourceStatus),
          ))
      }

      const completedState = async ({ StackId, reportEvents, waitForCleanup }) => {
        let haveReportedFailures = false
        const reportedLogicalIds = []
        let state
        let delaySeconds = 2
        for (;;) {
          const describeResult = await cfn.describeStacks({ StackName: StackId }).promise()
          state = describeResult.Stacks[0]
          const completed = ! isInProgress(state) || (! waitForCleanup && isCleanupInProgress(state))
          if (reportEvents) {
            const stackEvents = await retrieveStackEvents({ StackId })
            stackEvents
              .filter(e => e.LogicalResourceId && e.PhysicalResourceId !== StackId)
              .forEach((e) => {
                if (! includes(reportedLogicalIds, e.LogicalResourceId)) {
                  const prefix = `${StackName}.${e.LogicalResourceId}`
                  if (startsWith(e.ResourceStatus, 'CREATE')) {
                    log(`${prefix}: ${colors.green('✔ creating')}`)
                  } else if (startsWith(e.ResourceStatus, 'UPDATE')) {
                    log(`${prefix}: ✱ updating`)
                  } else if (startsWith(e.ResourceStatus, 'DELETE')) {
                    log(`${prefix}: ${colors.dim('✘ deleting')}`)
                  }
                  reportedLogicalIds.push(e.LogicalResourceId)
                }
              })
            if (! haveReportedFailures && stackStateIndicatesFailure(state)) {
              logFailures(stackEvents)
              log(
                'See full details at:',
                colors.blue.underline(`https://${serviceOptions.region}.console.aws.amazon.com/cloudformation/home?region=${serviceOptions.region}#/stack/detail?stackId=${encodeURIComponent(StackId)}`),
              )
              haveReportedFailures = true
            }
          }
          log(
            `${StackName}: ${state.StackStatus}`,
            completed ? '' : colors.dim(`checking again in ${delaySeconds}s...`),
          )
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
        if (isInProgress(initialState)) {
          log(`${StackName}: waiting for previous operation to complete`)
          initialState = await completedState({
            StackId: initialState.StackId,
            reportEvents: false,
            waitForCleanup: true,
          })
          log(`${StackName}: starting deployment`)
        }
      } else {
        log(`${StackName}: creating new stack`)
      }
      const updating = initialState != null
      const deployParams = {
        ...(updating ? {} : { OnFailure: 'DELETE' }),  // Put this first so can be overridden by passed params
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
        resultState = await completedState({
          StackId: deployResult.StackId,
          reportEvents: true,
          waitForCleanup: false,
        })
      } catch (e) {
        if (updating && e.code === 'ValidationError' && e.message === 'No updates are to be performed.') {
          // CloudFormation will only update if *resources* will change, for example: changes to Outputs don't count
          resultState = initialState
        } else {
          throw e
        }
      }
      if (! isDeployComplete(resultState)) {
        if (endsWith(resultState.StackStatus, '_FAILED')) {
          logFailures(await retrieveStackEvents({ StackId: resultState.StackId }))
        }
        throw new Err(`Deploying ${StackName} failed (${resultState.StackStatusReason || resultState.StackStatus})`)
      }
      const output = simplifiedOutput(resultState)
      const outputFile = file.clone({ contents: false })
      outputFile.contents = new Buffer(JSON.stringify(output, null, 2), 'utf8')
      outputFile.data = output
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
