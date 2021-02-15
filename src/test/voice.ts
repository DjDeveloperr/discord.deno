import { CommandBuilder } from '../models/command.ts'
import { CommandClient } from '../models/commandClient.ts'
import { Intents } from '../utils/intents.ts'
import { TOKEN } from './config.ts'

const client = new CommandClient({
  prefix: '.',
  spacesAfterPrefix: true,
  caseSensitive: false
})

client.on('debug', console.log)
client.on('ready', () => console.log(`Connected as ${client.user?.tag}!`))

const join = new CommandBuilder().setName('join').onExecute(async (ctx) => {
  try {
    if (ctx.guild === undefined) return
    const vs = await ctx.guild.voiceStates.get(ctx.author.id)
    if (vs === undefined || vs.channel === null) return
    console.log('Joining...')
    const data = await vs.channel.join({ onlyJoin: false })
    console.log('Joined!')
    data.guild = undefined as any
    console.log('[Voice::Join]', data)
    ctx.message.reply('Joined!')
  } catch (e) {
    console.log(e)
  }
})

client.commands.add(join)

const leave = new CommandBuilder().setName('leave').onExecute(async (ctx) => {
  if (ctx.guild === undefined) return
  const vs = await ctx.guild.voiceStates.get(client.user?.id as string)
  if (vs === undefined) return
  await vs.channel?.leave()
  ctx.message.reply('Left!')
})

client.commands.add(leave)

client.on('commandError', (_, err) => console.log(err))

client.connect(TOKEN, Intents.All)
