import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test } from 'bun:test'
import { AuthController } from '../auth/controller'
import { TEST_CONFIG } from '../test/context'
import { AUTH_REQUIRED_MESSAGE, AUTH_TOOL_DESCRIPTION } from '../auth/tool'
import { PUBLIC_TOOLS } from '../tools'
import { createMcpServer } from './server'

async function connectUnsigned() {
  const auth = new AuthController({
    ...TEST_CONFIG,
    telegram: { ...TEST_CONFIG.telegram, apiId: 0, apiHash: '' },
  })
  const server = createMcpServer(auth)
  const client = new Client({ name: 'tgmcp-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { auth, server, client }
}

describe('MCP server', () => {
  test('registers without throwing when unsigned', () => {
    const auth = new AuthController({
      ...TEST_CONFIG,
      telegram: { ...TEST_CONFIG.telegram, apiId: 0, apiHash: '' },
    })
    expect(() => createMcpServer(auth)).not.toThrow()
  })

  test('lists auth and inbox tools before sign-in', async () => {
    const { client, server } = await connectUnsigned()
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'auth',
        ...PUBLIC_TOOLS.map((tool) => tool.name),
      ])
      expect(listed.tools[0]?.description).toBe(AUTH_TOOL_DESCRIPTION)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('inbox tools refuse work until signed in', async () => {
    const { client, server } = await connectUnsigned()
    try {
      const result = await client.callTool({ name: 'list_chats', arguments: {} })
      expect(result.isError).toBe(true)
      const payload = JSON.stringify(result)
      expect(payload).toContain(AUTH_REQUIRED_MESSAGE)
      expect(payload).toContain('auth tool')
      expect(payload).toContain('authenticate')
    } finally {
      await client.close()
      await server.close()
    }
  })
})

