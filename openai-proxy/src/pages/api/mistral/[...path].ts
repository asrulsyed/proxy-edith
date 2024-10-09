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

// CORS headers helper function
function getCorsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, OpenAI-Beta, OpenAI-Organization',
  });

  // Check if the origin is allowed (you can implement your own logic here)
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }

  return headers;
}

export default async function handler(req: NextRequest) {
  // Get the origin from the request headers
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip'
    await waitForCooldown(clientIP)

    const url = new URL(req.url)
    const path = url.pathname.split('/api/mistral/')[1]
    const targetUrl = `${MISTRAL_BASE_URL}/${path}`

    const headers = new Headers(req.headers)
    
    const apiKey = headers.get('authorization')?.split('Bearer ')[1] || process.env.MISTRAL_API_KEY
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API key is required' }),
        {
          status: 401,
          headers: {
            ...Object.fromEntries(corsHeaders),
            'Content-Type': 'application/json',
          },
        }
      )
    }

    headers.set('Authorization', `Bearer ${apiKey}`)
    headers.set('Host', 'api.mistral.ai')
    headers.set('Content-Type', 'application/json')
    
    headers.delete('connection')
    headers.delete('transfer-encoding')

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    })

    const responseHeaders = new Headers(response.headers)
    // Add CORS headers to the response
    corsHeaders.forEach((value, key) => {
      responseHeaders.set(key, value);
    });
    
    responseHeaders.delete('transfer-encoding')
    responseHeaders.delete('connection')

    const isStreaming = response.headers.get('content-type')?.includes('stream')

    if (isStreaming) {
      const transformStream = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
      })

      const streamedResponse = response.body?.pipeThrough(transformStream)
      if (!streamedResponse) {
        throw new Error('No response body')
      }

      return new Response(streamedResponse, {
        status: response.status,
        headers: responseHeaders,
      })
    }

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
          ...Object.fromEntries(corsHeaders),
          'Content-Type': 'application/json',
        },
      }
    )
  }
}