import { NextRequest } from 'next/server'

export const config = {
  runtime: 'edge',
}

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
const RATE_LIMIT_DURATION = 1000 // 1 second in milliseconds

// Using a Map to store the last request time for each IP
const ipLastRequestMap = new Map<string, number>()

async function waitForCooldown(ip: string): Promise<void> {
  const lastRequestTime = ipLastRequestMap.get(ip) || 0
  const currentTime = Date.now()
  const timeElapsed = currentTime - lastRequestTime
  
  if (timeElapsed < RATE_LIMIT_DURATION) {
    const waitTime = RATE_LIMIT_DURATION - timeElapsed
    await new Promise(resolve => setTimeout(resolve, waitTime))
  }
  
  ipLastRequestMap.set(ip, Date.now())
}

export default async function handler(req: NextRequest) {
  try {
    // Get the client's IP address
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip'
    
    // Wait for the cooldown period if necessary
    await waitForCooldown(clientIP)

    // Extract the path and construct the target URL
    const url = new URL(req.url)
    const path = url.pathname.split('/api/mistral/')[1]
    const targetUrl = `${MISTRAL_BASE_URL}/${path}`

    // Clone the request headers
    const headers = new Headers(req.headers)
    
    // Keep the client's API key or use a default one
    const apiKey = headers.get('authorization')?.split('Bearer ')[1] || process.env.MISTRAL_API_KEY
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API key is required' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Update or add necessary headers
    headers.set('Authorization', `Bearer ${apiKey}`)
    headers.set('Host', 'api.mistral.ai')
    headers.set('Content-Type', 'application/json')
    
    // Remove any headers that might cause issues
    headers.delete('connection')
    headers.delete('transfer-encoding')

    // Forward the request to Mistral AI
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    })

    // Prepare response headers
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('transfer-encoding')
    responseHeaders.delete('connection')

    // Check if the response is streaming
    const isStreaming = response.headers.get('content-type')?.includes('stream')

    if (isStreaming) {
      // For streaming responses, create a TransformStream to process chunks
      const transformStream = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
      })

      // Pipe the response body through our transform stream
      const streamedResponse = response.body?.pipeThrough(transformStream)
      if (!streamedResponse) {
        throw new Error('No response body')
      }

      // Return a streaming response
      return new Response(streamedResponse, {
        status: response.status,
        headers: responseHeaders,
      })
    }

    // For non-streaming responses, forward as-is
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (error) {
    console.error('Proxy error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  }
}