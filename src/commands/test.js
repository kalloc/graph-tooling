const { Binary } = require('binary-install-raw')
const os = require('os')
const chalk = require('chalk')
const fetch = require('node-fetch')
const fs = require('fs')
const { fixParameters } = require('../command-helpers/gluegun')
const semver = require('semver')
const { spawn, exec } = require('child_process')

const HELP = `
${chalk.bold('graph test')} ${chalk.dim('[options]')} ${chalk.bold('<datasource>')}

${chalk.dim('Options:')}
  -c, --coverage                Run the tests in coverage mode. Works with v0.2.1 and above (0.2.2 and above in docker mode)
  -d, --docker                  Run the tests in a docker container(Note: Please execute from the root folder of the subgraph)
  -f  --force                   Binary - overwrites folder + file when downloading. Docker - rebuilds the docker image
  -h, --help                    Show usage information
  -l, --logs                    Logs to the console information about the OS, CPU model and download url (debugging purposes)
  -v, --version <tag>           Choose the version of the rust binary that you want to be downloaded/used
  `

module.exports = {
  description: 'Runs rust binary for subgraph testing',
  run: async toolbox => {
    // Obtain tools
    let { print } = toolbox

    // Read CLI parameters
    let {
      c,
      coverage,
      d,
      docker,
      f,
      force,
      h,
      help,
      l,
      logs,
      v,
      version,
    } = toolbox.parameters.options

    // Support both long and short option variants
    let coverageOpt = coverage || c
    let dockerOpt = docker || d
    let forceOpt = force || f
    let helpOpt = help || h
    let logsOpt = logs || l
    let versionOpt = version || v

    // Fix if a boolean flag (e.g -c, --coverage) has an argument
    try {
      fixParameters(toolbox.parameters, {
        h,
        help,
        c,
        coverage,
        d,
        docker,
        f,
        force,
        l,
        logs
      })
    } catch (e) {
      print.error(e.message)
      process.exitCode = 1
      return
    }

    let datasource = toolbox.parameters.first || toolbox.parameters.array[0]

    // Show help text if requested
    if (helpOpt) {
      print.info(HELP)
      return
    }

    let result = await fetch('https://api.github.com/repos/LimeChain/matchstick/releases/latest')
    let json = await result.json()
    let latestVersion = json.tag_name

    if(dockerOpt) {
      runDocker(coverageOpt, datasource, versionOpt, latestVersion, forceOpt, print)
    } else {
      runBinary(coverageOpt, datasource, forceOpt, logsOpt, versionOpt, latestVersion, print)
    }
  }
}

async function runBinary(coverageOpt, datasource, forceOpt, logsOpt, versionOpt, latestVersion, print) {
  const platform = getPlatform(logsOpt)

  const url = `https://github.com/LimeChain/matchstick/releases/download/${versionOpt || latestVersion}/${platform}`

  if (logsOpt) {
    console.log(`Download link: ${url}`)
  }

  let binary = new Binary(platform, url, versionOpt)
  forceOpt ? await binary.install(true) : await binary.install(false)
  let args = ""

  if (datasource) args = datasource
  if (coverageOpt) args = args + ' -c'
  args !== '' ? binary.run(args.trim()) : binary.run()
}

function getPlatform(logsOpt) {
  const type = os.type()
  const arch = os.arch()
  const release = os.release()
  const cpuCore = os.cpus()[0]
  const majorVersion = semver.major(release)
  const isM1 = cpuCore.model.includes("Apple M1")

  if (logsOpt) {
    console.log(`OS type: ${type}\nOS arch: ${arch}\nOS release: ${release}\nOS major version: ${majorVersion}\nCPU model: ${cpuCore.model}`)
  }

  if (arch === 'x64' || (arch === 'arm64' && isM1)) {
    if (type === 'Darwin') {
      if (majorVersion === 19) {
        return 'binary-macos-10.15'
      } else if (majorVersion === 18) {
        return 'binary-macos-10.14'
      } else if (isM1) {
        return 'binary-macos-11-m1'
      }
      return 'binary-macos-11'
    } else if (type === 'Linux') {
      if (majorVersion === 18) {
        return 'binary-linux-18'
      }
      return 'binary-linux-20'
    } else if (type === 'Windows_NT') {
      return 'binary-windows'
    }
  }

  throw new Error(`Unsupported platform: ${type} ${arch} ${majorVersion}`)
}

function runDocker(coverageOpt, datasource, versionOpt, latestVersion, forceOpt, print) {
  // Remove binary-install-raw binaries, because docker has permission issues
  // when building the docker images
  fs.rmSync("node_modules/binary-install-raw/bin", { force: true, recursive: true });

  let dir = 'tests/.docker';

  if (!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    fs.writeFileSync(`${dir}/Dockerfile`, dockerfile(versionOpt, latestVersion))
    print.info('Successfully generated Dockerfile.');
  } catch (error) {
    print.info('A problem occurred while generating the Dockerfile. Please attend to the errors below:');
    print.info(chalk.red(error));
    return
  }

  // Run a command to check if matchstick image already exists
  exec('docker images -q matchstick', (error, stdout, stderr) => {
    // Getting the current working folder that will be passed to the
    // `docker run` command to be bind mounted.
    let current_folder = process.cwd();
    let testArgs = '';

    if(datasource) {
      testArgs = testArgs + datasource
    }

    if(coverageOpt) {
      testArgs = testArgs + ' ' + '-c'
    }

    let dockerRunOpts = ['run', '-it', '--rm', '--mount', `type=bind,source=${current_folder},target=/matchstick`];

    if(testArgs !== '') {
      dockerRunOpts.push('-e')
      dockerRunOpts.push(`ARGS=${testArgs.trim()}`);
    }

    dockerRunOpts.push('matchstick')

    // If a matchstick image does not exists, the command returns an empty string,
    // else it'll return the image ID. Skip `docker build` if an image already exists
    // If `-v/--version` is specified, delete current image(if any) and rebuild.
    // Use spawn() and {stdio: 'inherit'} so we can see the logs in real time.
    if(stdout === '' || versionOpt || forceOpt) {
      if ((stdout !== '' && versionOpt) || forceOpt) {
        exec('docker image rm matchstick', (error, stdout, stderr) => {
          print.info(chalk.bold(`Removing matchstick image\n${stdout}`));
        });
      }
      // Build a docker image. If the process has executed successfully
      // run a container from that image.
      spawn(
        'docker',
        ['build', '-f', 'tests/.docker/Dockerfile', '-t', 'matchstick', '.'],
        { stdio: 'inherit' }
      ).on('close', code => {
        if (code === 0) {
           spawn('docker', dockerRunOpts, { stdio: 'inherit' });
        }
      })
    } else {
      // Run the container from the existing matchstick docker image
      spawn('docker', dockerRunOpts, { stdio: 'inherit' });
    }
  })
}

// TODO: Move these in separate file (in a function maybe)
function dockerfile(versionOpt, latestVersion) {
  return `
  FROM ubuntu:20.04
  ENV ARGS=""

  # Install necessary packages
  RUN apt update
  RUN apt install -y nodejs
  RUN apt install -y npm
  RUN apt install -y git
  RUN apt install -y postgresql
  RUN apt install -y curl
  RUN npm install -g @graphprotocol/graph-cli

  # Download the latest linux binary
  RUN curl -OL https://github.com/LimeChain/matchstick/releases/download/${versionOpt || latestVersion}/binary-linux-20

  # Make it executable
  RUN chmod a+x binary-linux-20

  # Create a matchstick dir where the host will be copied
  RUN mkdir matchstick
  WORKDIR matchstick

  # Copy host to /matchstick
  COPY ../ .

  RUN graph codegen
  RUN graph build

  CMD ../binary-linux-20 \${ARGS}`
}
