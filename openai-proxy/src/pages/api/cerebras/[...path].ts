import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const config = {
  runtime: 'edge',
}

const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https:aaaa'
const API_KEY = process.env.API_KEY
const RATE_LIMIT_DURATION = 1000 // 1 second in milliseconds
const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || ""

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
  let requestBody = '';
  let responseBody = '';
  let responseStatus = 500;
  let responseHeaders: Headers | undefined = undefined;
  let targetUrl = '';

  try {
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip'
    await waitForCooldown(clientIP)

    const path = req.url.split('/api/cerebras/')[1]
    targetUrl = `${TARGET_BASE_URL}/${path}`

    const headers = new Headers(req.headers)
    headers.set('Authorization', `Bearer ${API_KEY}`)
    headers.set('Host', new URL(TARGET_BASE_URL).host)
    headers.set('Content-Type', 'application/json')
    headers.delete('connection')
    headers.delete('transfer-encoding')

    requestBody = await req.text();

    console.log('Request:', {
      ip: clientIP,
      method: req.method,
      path: req.url,
      targetUrl: targetUrl,
      request_headers: Object.fromEntries(req.headers),
      request_body: requestBody,
    })

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: requestBody,
    })

    responseHeaders = new Headers(response.headers)
    responseHeaders.set('Access-Control-Allow-Origin', '*')
    responseHeaders.set('Access-Control-Allow-Methods', '*')
    responseHeaders.set('Access-Control-Allow-Headers', '*')
    responseHeaders.set('Access-Control-Allow-Credentials', 'true') 
    responseHeaders.delete('transfer-encoding')
    responseHeaders.delete('connection')

    responseStatus = response.status;

    const isStreaming = response.headers.get('content-type')?.includes('stream')
    if (isStreaming) {
      const streamedResponse = response.body
      if (!streamedResponse) {
        throw new Error('No response body')
      }

      // Log streaming response details
      console.log('Streaming Response:', {
        response_status: responseStatus,
        response_headers: Object.fromEntries(responseHeaders),
      })

      // Return a streaming response
      return new Response(streamedResponse, {
        status: responseStatus,
        headers: responseHeaders,
      })
    } else {
      // For non-streaming responses, read the body once
      responseBody = await response.text();

      // Log non-streaming response details
      console.log('Response:', {
        response_status: responseStatus,
        response_headers: Object.fromEntries(responseHeaders),
        response_body: responseBody,
      })

      // Return a non-streaming response
      return new Response(responseBody, {
        status: responseStatus,
        headers: responseHeaders,
      })
    }

  } catch (error: unknown) {
    console.error('Proxy error:', error)
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error details:', errorMessage);

    responseBody = JSON.stringify({ error: 'Internal Server Error' });
    responseStatus = 500;
    responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'application/json'); 
  } finally {
    try {
      await supabase.from('api_logs').insert({
        ip: req.headers.get('x-forwarded-for') || 'unknown-ip',
        method: req.method,
        path: req.url,
        targetUrl: targetUrl,
        request_headers: Object.fromEntries(req.headers),
        request_body: requestBody,
        response_status: responseStatus,
        response_headers: responseHeaders ? Object.fromEntries(responseHeaders) : {},
        response_body: responseBody,
        timestamp: new Date().toISOString(),
      })
    } catch (supabaseError) {
      console.error('Error logging to Supabase:', supabaseError)
    }
  }

  return new Response(responseBody, {
    status: responseStatus,
    headers: responseHeaders,
  })
}