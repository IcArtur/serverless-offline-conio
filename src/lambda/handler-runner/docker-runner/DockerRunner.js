import DockerContainer from './DockerContainer.js'
import { checkDockerDaemon } from '../../../utils/index.js'

export default class DockerRunner {
  #codeDir = null

  #container = null

  constructor(funOptions, env, dockerOptions) {
    const {
      codeDir,
      functionKey,
      handler,
      runtime,
      layers,
      layersConfig,
      provider,
      servicePath,
      serviceLayers,
    } = funOptions

    this.#codeDir = codeDir

    if (
      dockerOptions.hostServicePath &&
      this.#codeDir.startsWith(servicePath)
    ) {
      this.#codeDir = this.#codeDir.replace(
        servicePath,
        dockerOptions.hostServicePath,
      )
    }

    this.#container = new DockerContainer(
      env,
      functionKey,
      handler,
      runtime,
      layers,
      layersConfig,
      provider,
      servicePath,
      dockerOptions,
      serviceLayers,
    )
  }

  cleanup() {
    if (this.#container) {
      return this.#container.stop()
    }

    return undefined
  }

  // context will be generated in container
  async run(event) {
    // FIXME TODO this should run only once -> static private
    await checkDockerDaemon()

    if (!this.#container.isRunning) {
      await this.#container.start(this.#codeDir)
    }

    return this.#container.request(event)
  }
}
