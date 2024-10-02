// src/pages/api/cerebras/[...path].ts
import { NextRequest } from 'next/server'

export const config = {
  runtime: 'edge',
}

const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://api.cerebras.com'
const API_KEY = process.env.API_KEY

export default async function handler(req: NextRequest) {
  try {
    const path = req.url.split('/api/cerebras/')[1]
    const targetUrl = `${TARGET_BASE_URL}/${path}`

    // Clone the request headers
    const headers = new Headers(req.headers)
    
    // Update or add necessary headers
    headers.set('Authorization', `Bearer ${API_KEY}`)
    headers.set('Host', new URL(TARGET_BASE_URL).host)
    
    // Remove any headers that might cause issues
    headers.delete('connection')
    headers.delete('transfer-encoding')

    // Forward the request to OpenAI
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    })

    // Prepare response headers
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('transfer-encoding')
    responseHeaders.delete('connection')

    // Check if the response is streaming based on content-type
    const isStreaming = response.headers.get('content-type')?.includes('stream')

    if (isStreaming) {
      // Return a streaming response directly using the response body
      return new Response(response.body, {
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