import { Sandbox } from '../index.js'

async function main() {
  const sandbox = new Sandbox({ persistSession: true })

  await sandbox.exec('mkdir -p /workspace/logs && cd /workspace')
  await sandbox.exec("echo 'error: disk full\ninfo: started\nerror: disk full' > logs/app.log")

  const count = await sandbox.exec('grep -c error logs/app.log')
  console.log(`error lines: ${count.stdout.trim()}`)

  const unique = await sandbox.exec('sort -u logs/app.log | wc -l && echo exit=$?')
  process.stdout.write(unique.stdout)

  await sandbox.exec('grep error logs/app.log > errors.txt')
  const errors = await sandbox.exec('cat /workspace/errors.txt')
  process.stdout.write(errors.stdout)

  console.log(`last exec: ${errors.wallTimeMs.toFixed(2)}ms across ${errors.commands.length} command(s)`)
  console.log('stats:', await sandbox.stats())
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
