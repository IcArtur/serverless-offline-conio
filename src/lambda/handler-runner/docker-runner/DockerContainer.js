import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join, sep, resolve as pathResolve } from 'node:path'
import process from 'node:process'
import { LambdaClient, GetLayerVersionCommand } from '@aws-sdk/client-lambda'
import { log, progress } from '@serverless/utils/log.js'
import { execa } from 'execa'
import pkg from 'fs-extra'
import isWsl from 'is-wsl'
import jszip from 'jszip'
import DockerImage from './DockerImage.js'

const { stringify } = JSON
const { floor, log: mathLog } = Math
const { parseFloat } = Number
const { entries, hasOwn } = Object
const { mkdirSync, copySync, ensureDir, pathExists } = pkg

export default class DockerContainer {
  #containerId = null

  #dockerOptions = null

  #env = null

  #functionKey = null

  #gatewayAddress = null

  #handler = null

  #image = null

  #imageNameTag = null

  #lambdaClient = null

  #layers = null

  #port = null

  #provider = null

  #runtime = null

  #servicePath = null

  #serviceLayers = null

  constructor(
    env,
    functionKey,
    handler,
    runtime,
    layers,
    provider,
    servicePath,
    dockerOptions,
    serviceLayers,
  ) {
    this.#dockerOptions = dockerOptions
    this.#env = env
    this.#functionKey = functionKey
    this.#gatewayAddress = process.env.GATEWAY_ADDRESS
    this.#handler = handler
    this.#imageNameTag = this.#baseImage(runtime)
    this.#image = new DockerImage(this.#imageNameTag)
    this.#layers = layers
    this.#provider = provider
    this.#runtime = runtime
    this.#servicePath = servicePath
    this.#serviceLayers = serviceLayers
  }

  #baseImage(runtime) {
    return `public.ecr.aws/lambda/python:${runtime.replace('python', '')}`
  }

  async start(codeDir) {
    await this.#image.pull()

    log.debug('Run Docker container...')

    let permissions = 'ro'

    if (!this.#dockerOptions.readOnly) {
      permissions = 'rw'
    }
    // https://github.com/serverless/serverless/blob/v1.57.0/lib/plugins/aws/invokeLocal/index.js#L291-L293
    const dockerArgs = [
      '-v',
      `${codeDir}:/var/task:${permissions},delegated`,
      '-p',
      8080,
      '-e',
      'PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python',
      '-e',
      'DOCKER_LAMBDA_STAY_OPEN=1', // API mode
      '-e',
      'DOCKER_LAMBDA_WATCH=1', // Watch mode
    ]

    if (this.#layers.length > 0) {
      log.verbose(`Found layers, checking provider type`)

      if (this.#provider.name.toLowerCase() === 'aws') {
        let layerDir = this.#dockerOptions.layersDir

        if (!layerDir) {
          layerDir = join(this.#servicePath, '.serverless-offline', 'layers')
        }

        layerDir = join(layerDir, this.#getLayersSha256())

        if (await pathExists(layerDir)) {
          log.verbose(
            `Layers already exist for this function. Skipping download.`,
          )
        } else {
          log.verbose(`Storing layers at ${layerDir}`)

          // Only initialise if we have layers, we're using AWS, and they don't already exist
          this.#lambdaClient = new LambdaClient({
            apiVersion: '2015-03-31',
            region: this.#provider.region,
          })

          log.verbose(`Getting layers`)
          await Promise.all(
            this.#layers.map((layerArn) => {
              log.verbose(`Getting layer ${JSON.stringify(layerArn)}`)
              if (
                typeof layerArn === 'string' &&
                layerArn.includes(':layer:')
              ) {
                log.debug(`Using download instead of copy: ${layerArn}`)
                return this.#downloadLayer(layerArn, layerDir)
              }
              return this.#copyLocalLayer(layerArn, layerDir)
            }),
          )
        }

        if (
          this.#dockerOptions.hostServicePath &&
          layerDir.startsWith(this.#servicePath)
        ) {
          layerDir = layerDir.replace(
            this.#servicePath,
            this.#dockerOptions.hostServicePath,
          )
        }
        dockerArgs.push('-v', `${pathResolve(layerDir)}:/opt:ro,delegated`)
      } else {
        log.warning(
          `Provider ${this.#provider.name} is Unsupported. Layers are only supported on aws.`,
        )
      }
    }

    entries(this.#env).forEach(([key, value]) => {
      dockerArgs.push('-e', `${key}=${value}`)
    })

    if (platform() === 'linux' && !isWsl) {
      // Add `host.docker.internal` DNS name to access host from inside the container
      // https://github.com/docker/for-linux/issues/264
      const gatewayIp = await this.#getBridgeGatewayIp()
      if (gatewayIp) {
        dockerArgs.push('--add-host', `host.docker.internal:${gatewayIp}`)
      }
    }

    if (this.#dockerOptions.network) {
      dockerArgs.push('--network', this.#dockerOptions.network)
    }

    const { stdout: containerId } = await execa('docker', [
      'create',
      ...dockerArgs,
      this.#imageNameTag,
      this.#handler,
    ])

    const dockerStart = execa('docker', ['start', '-a', containerId], {
      all: true,
    })

    await new Promise((resolve, reject) => {
      dockerStart.all.on('data', (data) => {
        const str = String(data)
        log.error(str)

        const startupString =
          "exec '/var/runtime/bootstrap' (cwd=/var/task, handler=)"
        if (str.includes(startupString)) {
          resolve()
        }
      })

      dockerStart.on('error', (err) => {
        reject(err)
      })
    })

    // parse `docker port` output and get the container port
    let containerPort
    const { stdout: dockerPortOutput } = await execa('docker', [
      'port',
      containerId,
    ])
    // NOTE: `docker port` may output multiple lines.
    //
    // e.g.:
    // 8080/tcp -> 0.0.0.0:49153
    // 8080/tcp -> :::49153
    //
    // Parse each line until it finds the mapped port.
    for (const line of dockerPortOutput.split('\n')) {
      const result = line.match(/^8080\/tcp -> (.*):(\d+)$/)
      if (result && result.length > 2) {
        ;[, , containerPort] = result
        break
      }
    }
    if (!containerPort) {
      throw new Error('Failed to get container port')
    }

    this.#containerId = containerId
    this.#port = containerPort
  }

  async #copyLocalLayer(layerArn, layerDir) {
    const layerName = layerArn.Ref
    const serviceLayerName = layerName.replace('LambdaLayer', '')
    const serviceLayer = this.#serviceLayers[serviceLayerName]
    const layerDataLocation = pathResolve(serviceLayer.path)

    log.verbose(`[${layerName}] Location: ${layerDataLocation}`)

    if (
      Object.prototype.hasOwnProperty.call(
        serviceLayer,
        'CompatibleRuntimes',
      ) &&
      !serviceLayer.CompatibleRuntimes.includes(this.#runtime)
    ) {
      log.warning(
        `[${layerName}] Layer is not compatible with ${this.#runtime} runtime`,
      )
      return
    }

    log.verbose(`
      [${layerName}] Copying data from ${layerDataLocation} to ${layerDir}...`)

    mkdirSync(layerDir, { recursive: true })
    copySync(layerDataLocation, layerDir, { recursive: true }, (err) => {
      if (err) {
        log.verbose(`[${layerName}] ERROR`)
      } else {
        log.verbose(`[${layerName}] Done`)
      }
    })
  }

  async #downloadLayer(layerArn, layerDir) {
    const [, layerName] = layerArn.split(':layer:')
    const layerZipFile = `${layerDir}/${layerName}.zip`
    const layerProgress = progress.get(`layer-${layerName}`)

    log.verbose(`[${layerName}] ARN: ${layerArn}`)

    log.verbose(`[${layerName}] Getting Info`)
    layerProgress.notice(`Retrieving "${layerName}": Getting info`)

    const getLayerVersionCommand = new GetLayerVersionCommand({
      LayerName: layerArn,
    })

    try {
      let layer = null

      try {
        layer = await this.#lambdaClient.send(getLayerVersionCommand)
      } catch (err) {
        log.warning(`[${layerName}] ${err.code}: ${err.message}`)

        return
      }

      if (
        hasOwn(layer, 'CompatibleRuntimes') &&
        !layer.CompatibleRuntimes.includes(this.#runtime)
      ) {
        log.warning(
          `[${layerName}] Layer is not compatible with ${this.#runtime} runtime`,
        )

        return
      }

      const { CodeSize: layerSize, Location: layerUrl } = layer.Content
      // const layerSha = layer.Content.CodeSha256

      await ensureDir(layerDir)

      log.verbose(
        `Retrieving "${layerName}": Downloading ${this.#formatBytes(
          layerSize,
        )}...`,
      )
      layerProgress.notice(
        `Retrieving "${layerName}": Downloading ${this.#formatBytes(
          layerSize,
        )}`,
      )

      const res = await fetch(layerUrl)

      if (!res.ok) {
        log.warning(
          `[${layerName}] Failed to fetch from ${layerUrl} with ${res.statusText}`,
        )

        return
      }

      const fileStream = createWriteStream(layerZipFile)

      await new Promise((resolve, reject) => {
        res.body.pipe(fileStream)
        res.body.on('error', (err) => {
          reject(err)
        })
        fileStream.on('finish', () => {
          resolve()
        })
      })

      log.verbose(`Retrieving "${layerName}": Unzipping to .layers directory`)
      layerProgress.notice(
        `Retrieving "${layerName}": Unzipping to .layers directory`,
      )

      const data = await readFile(layerZipFile)
      const zip = await jszip.loadAsync(data)

      await Promise.all(
        entries(zip.files).map(async ([filename, jsZipObj]) => {
          const fileData = await jsZipObj.async('nodebuffer')
          if (filename.endsWith(sep)) {
            return undefined
          }
          await ensureDir(join(layerDir, dirname(filename)))
          return writeFile(join(layerDir, filename), fileData, {
            mode: zip.files[filename].unixPermissions,
          })
        }),
      )

      log.verbose(`[${layerName}] Removing zip file`)

      await unlink(layerZipFile)
    } finally {
      layerProgress.remove()
    }
  }

  async #getBridgeGatewayIp() {
    let gateway
    try {
      ;({ stdout: gateway } = await execa('docker', [
        'network',
        'inspect',
        'bridge',
        '--format',
        '{{(index .IPAM.Config 0).Gateway}}',
      ]))
    } catch (err) {
      log.error(err.stderr)

      throw err
    }
    return gateway.split('/')[0]
  }

  async request(event) {
    const url = `http://${this.#gatewayAddress}:${this.#port}/2015-03-31/functions/function/invocations`
    const res = await fetch(url, {
      body: stringify(event),
      headers: { 'Content-Type': 'application/json' },
      method: 'post',
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch from ${url} with ${res.statusText}`)
    }

    return res.json()
  }

  async stop() {
    if (this.#containerId) {
      try {
        await execa('docker', ['stop', this.#containerId])
        await execa('docker', ['rm', this.#containerId])
      } catch (err) {
        log.error(err.stderr)

        throw err
      }
    }
  }

  #formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes'

    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

    const i = floor(mathLog(bytes) / mathLog(k))

    return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`
  }

  #getLayersSha256() {
    return createHash('sha256').update(stringify(this.#layers)).digest('hex')
  }

  get isRunning() {
    return this.#containerId !== null && this.#port !== null
  }
}
