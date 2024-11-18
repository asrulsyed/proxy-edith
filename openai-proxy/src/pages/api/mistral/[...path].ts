import { NextRequest } from 'next/server'

export const config = {
  runtime: 'edge',
}

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
const BANNED_IPS = ['194.191.253.202']

function isBannedIP(ip: string): boolean {
  return BANNED_IPS.includes(ip)
}

async function notifyAdmin(ip: string): Promise<void> {
  // Implement your notification logic here
  console.log(`Admin notification: IP ${ip} has exceeded the request limit.`)
}

function getCorsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*' // Allow any header
  });

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin); // Allow your Ionic app's origin
  } else {
    headers.set('Access-Control-Allow-Origin', '*'); // Allow all origins (less secure - uncomment only for development if needed)
    // It's safer to specify the origin(s) you want to allow during production
  }

  return headers;
}

export default async function handler(req: NextRequest) {
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

    // Check if IP is banned
    if (isBannedIP(clientIP)) {
      return new Response('Your IP is banned from accessing this service.', {
        status: 403,
        headers: corsHeaders,
      })
    }

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
