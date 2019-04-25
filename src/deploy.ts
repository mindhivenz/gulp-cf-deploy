import CloudFormation, {
  CreateStackInput,
  Stack,
  StackEvent,
  Types,
  UpdateStackInput,
} from 'aws-sdk/clients/cloudformation'
import through2 from 'through2'
import PluginError from 'plugin-error'
import log from 'fancy-log'
import colors from 'ansi-colors'
import fromPairs from 'lodash/fromPairs'
import takeWhile from 'lodash/takeWhile'
import startsWith from 'lodash/startsWith'
import endsWith from 'lodash/endsWith'
import includes from 'lodash/includes'

const MAX_REPORT_SECONDS = 15

const error = (err: string | Error) =>
  new PluginError('cf-deploy', err, { showProperties: typeof err !== 'string' })

const isInProgress = (state: Stack) =>
  endsWith(state.StackStatus, '_IN_PROGRESS')

const isCleanupInProgress = (state: Stack) =>
  endsWith(state.StackStatus, '_CLEANUP_IN_PROGRESS')

const isInitialStackEvent = (event: StackEvent, StackId: string) =>
  event.PhysicalResourceId === StackId &&
  ['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS'].some(
    s => s === event.ResourceStatus,
  )

const isFailedStackEvent = (event: StackEvent) =>
  endsWith(event.ResourceStatus, 'FAILED')

const stackStateIndicatesFailure = (state: Stack) =>
  ['ROLLBACK', 'DELETE', 'FAILED'].some(s => includes(state.StackStatus, s))

const isDeploySuccessful = (state: Stack) =>
  includes(state.StackStatus, 'COMPLETE') &&
  !includes(state.StackStatus, 'ROLLBACK') &&
  ['CREATE', 'UPDATE'].some(s => startsWith(state.StackStatus, s))

const simplifiedOutput = (state: Stack) =>
  fromPairs(
    state.Outputs!.map(({ OutputKey, OutputValue }) => [
      OutputKey,
      OutputValue,
    ]),
  )

interface IServiceOptions extends Types.ClientConfiguration {
  region: string // We require region
}

type StackInput = CreateStackInput | UpdateStackInput

// noinspection JSUnusedGlobalSymbols
export default (
  serviceOptions: IServiceOptions,
  stackNameOrOptions: string | StackInput | undefined,
  parameters: Record<string, string | number> = {},
) =>
  through2.obj(async (file, enc, done) => {
    const deploy = async () => {
      const stackOptions: StackInput =
        typeof stackNameOrOptions === 'string'
          ? { StackName: stackNameOrOptions }
          : typeof stackNameOrOptions === 'undefined'
          ? { StackName: file.stem }
          : stackNameOrOptions

      if (file.isNull()) {
        return file
      }
      if (!file.isBuffer()) {
        throw error(
          'Can only handle buffered files, pipe through vinyl-buffer beforehand',
        )
      }
      const stackName = stackOptions.StackName
      const cfn = new CloudFormation({
        apiVersion: '2010-05-15',
        ...serviceOptions,
      })

      const retrieveStackEvents = async (stackId: string) => {
        const eventsResult = await cfn
          .describeStackEvents({ StackName: stackId })
          .promise()
        return takeWhile(
          eventsResult.StackEvents,
          e => !isInitialStackEvent(e, stackId),
        ).reverse() // Change to chronological order
      }

      const logFailures = (stackEvents: StackEvent[]) => {
        stackEvents
          .filter(e => isFailedStackEvent(e))
          .forEach(e =>
            log(
              `${stackName}.${e.LogicalResourceId}:`,
              colors.dim(`(${e.ResourceStatus})`),
              colors.red(
                e.ResourceStatusReason || e.ResourceStatus || '<unknown>',
              ),
            ),
          )
      }

      const buildParameters = () => {
        return [
          ...(stackOptions.Parameters || []),
          ...Object.entries(parameters).map(([k, v]) => ({
            ParameterKey: k,
            ParameterValue: String(v),
          })),
        ]
      }

      const completedState = async ({
        StackId,
        reportEvents,
        waitForCleanup,
      }: {
        StackId: string
        reportEvents: boolean
        waitForCleanup: boolean
      }) => {
        let haveReportedFailures = false
        const reportedLogicalIds: string[] = []
        let state
        let delaySeconds = 2
        for (;;) {
          const describeResult = await cfn
            .describeStacks({ StackName: StackId })
            .promise()
          state = describeResult.Stacks![0]
          const completed =
            !isInProgress(state) ||
            (!waitForCleanup && isCleanupInProgress(state))
          if (reportEvents) {
            const stackEvents = await retrieveStackEvents(StackId)
            stackEvents
              .filter(
                e => e.LogicalResourceId && e.PhysicalResourceId !== StackId,
              )
              .forEach(e => {
                if (!includes(reportedLogicalIds, e.LogicalResourceId)) {
                  const prefix = `${stackName}.${e.LogicalResourceId}`
                  if (startsWith(e.ResourceStatus, 'CREATE')) {
                    log(`${prefix}: ${colors.green('✔ creating')}`)
                  } else if (startsWith(e.ResourceStatus, 'UPDATE')) {
                    log(`${prefix}: ✱ updating`)
                  } else if (startsWith(e.ResourceStatus, 'DELETE')) {
                    log(`${prefix}: ${colors.dim('✘ deleting')}`)
                  }
                  reportedLogicalIds.push(e.LogicalResourceId!)
                }
              })
            if (!haveReportedFailures && stackStateIndicatesFailure(state)) {
              logFailures(stackEvents)
              log(
                'See full details at:',
                colors.blue.underline(
                  `https://${
                    serviceOptions.region
                  }.console.aws.amazon.com/cloudformation/home?region=${
                    serviceOptions.region
                  }#/stack/detail?stackId=${encodeURIComponent(StackId)}`,
                ),
              )
              haveReportedFailures = true
            }
          }
          log(
            `${stackName}: ${state.StackStatus}`,
            completed
              ? ''
              : colors.dim(`checking again in ${delaySeconds}s...`),
          )
          if (completed) {
            return state
          }
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000)) // eslint-disable-line
          delaySeconds = Math.min(delaySeconds * 2, MAX_REPORT_SECONDS)
        }
      }

      let initialState: CloudFormation.Stack | undefined
      try {
        const describeResult = await cfn
          .describeStacks({ StackName: stackName })
          .promise()
        initialState = describeResult.Stacks![0]
      } catch (e) {
        if (e.code !== 'ValidationError') {
          throw e
        }
      }
      if (initialState) {
        if (isInProgress(initialState)) {
          log(`${stackName}: waiting for previous operation to complete`)
          initialState = await completedState({
            StackId: initialState.StackId!,
            reportEvents: false,
            waitForCleanup: true,
          })
          log(`${stackName}: starting deployment`)
        }
      } else {
        log(`${stackName}: creating new stack`)
      }
      const updating = initialState != null
      const deployParams: StackInput = {
        ...(updating ? {} : { OnFailure: 'DELETE' }), // Put this first so can be overridden by passed params
        ...stackOptions,
        Parameters: buildParameters(),
        TemplateBody: file.contents.toString(enc),
      }
      let resultState
      let skipped = false
      try {
        const request = updating
          ? cfn.updateStack(deployParams)
          : cfn.createStack(deployParams)
        const deployResult = await request.promise()
        resultState = await completedState({
          StackId: deployResult.StackId!,
          reportEvents: true,
          waitForCleanup: false,
        })
      } catch (e) {
        if (
          updating &&
          e.code === 'ValidationError' &&
          e.message === 'No updates are to be performed.'
        ) {
          // CloudFormation will only update if *resources* will change, for example: changes to Outputs don't count
          resultState = initialState! // Must exist since we're updating
          skipped = true
        } else {
          throw e
        }
      }
      if (!skipped && !isDeploySuccessful(resultState)) {
        if (endsWith(resultState.StackStatus, '_FAILED')) {
          logFailures(await retrieveStackEvents(resultState.StackId!))
        }
        throw error(
          `Deploying ${stackName} failed (${resultState.StackStatusReason ||
            resultState.StackStatus})`,
        )
      }
      const output = simplifiedOutput(resultState)
      const outputFile = file.clone({ contents: false })
      outputFile.contents = Buffer.from(JSON.stringify(output, null, 2), 'utf8')
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
        done(error(e))
      }
    }
  })
