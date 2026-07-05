import { Sandbox } from '../index.js'

async function main() {
  const sandbox = new Sandbox({
    commands: {
      shout: async ({ args, stdin }) => {
        const output = stdin.toString('utf8').toUpperCase()
        if (args[0]) {
          await sandbox.fs.writeFile(args[0], Buffer.from(output))
          return { exitCode: 0 }
        }
        return { stdout: Buffer.from(output) }
      }
    }
  })

  const discovered = await sandbox.exec('which shout && ls /bin | grep shout')
  process.stdout.write(discovered.stdout)

  const piped = await sandbox.exec('echo make some noise | shout')
  process.stdout.write(piped.stdout)

  await sandbox.exec('echo quiet words | shout /loud.txt')
  const file = await sandbox.exec('cat /loud.txt')
  process.stdout.write(file.stdout)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
