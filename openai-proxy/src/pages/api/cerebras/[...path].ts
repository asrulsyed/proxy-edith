import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const config = {
  runtime: 'edge',
}

const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https:aaaa'
const API_KEY = process.env.API_KEY
const RATE_LIMIT_DURATION = 1000 // 1 second in milliseconds
const SUPABASE_URL = process.env.SUPABASE_URL || ""
const SUPABASE_KEY = process.env.SUPABASE_KEY || ""
const ALLOWED_ORIGIN = 'chat.gaurish.xyz'

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

async function logToSupabase(logData: any) {
  try {
    // Clean and prepare the data for logging
    const cleanedData = {
      ...logData,
      // Convert headers objects to strings to prevent JSON serialization issues
      request_headers: JSON.stringify(logData.request_headers || {}),
      response_headers: JSON.stringify(logData.response_headers || {}),
      // Ensure request and response bodies are strings
      request_body: typeof logData.request_body === 'string' ? logData.request_body : JSON.stringify(logData.request_body),
      response_body: typeof logData.response_body === 'string' ? logData.response_body : JSON.stringify(logData.response_body),
      // Add timestamp
      created_at: new Date().toISOString()
    }

    const { error } = await supabase
      .from('api_logs')
      .insert([cleanedData])

    if (error) {
      console.error('Supabase logging error:', error)
    }
  } catch (error) {
    console.error('Error in logToSupabase:', error)
  }
}

export default async function handler(req: NextRequest) {
  const startTime = Date.now()
  let requestBody = '';
  let responseBody = '';
  let responseStatus = 500;
  let responseHeaders: Headers | undefined = undefined;
  let targetUrl = '';
  const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip'

  try {
    // Check origin/host of the request
    const origin = req.headers.get('origin');
    const referer = req.headers.get('referer');
    const host = origin || referer;

    if (!host || !host.includes(ALLOWED_ORIGIN)) {
      // Log unauthorized access attempt
      await logToSupabase({
        ip: clientIP,
        method: req.method,
        path: req.url,
        response_status: 403,
        response_body: 'Stop Abusing the Api',
        request_headers: Object.fromEntries(req.headers),
        error: 'Unauthorized origin'
      })

      return new Response('Stop Abusing the Api', {
        status: 403,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

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

      // Log streaming request
      await logToSupabase({
        ip: clientIP,
        method: req.method,
        path: req.url,
        targetUrl: targetUrl,
        request_headers: Object.fromEntries(req.headers),
        request_body: requestBody,
        response_status: responseStatus,
        response_headers: Object.fromEntries(responseHeaders),
        response_body: '[Streaming Response]',
        duration_ms: Date.now() - startTime
      })

      return new Response(streamedResponse, {
        status: responseStatus,
        headers: responseHeaders,
      })
    } else {
      responseBody = await response.text();

      // Log non-streaming request
      await logToSupabase({
        ip: clientIP,
        method: req.method,
        path: req.url,
        targetUrl: targetUrl,
        request_headers: Object.fromEntries(req.headers),
        request_body: requestBody,
        response_status: responseStatus,
        response_headers: Object.fromEntries(responseHeaders),
        response_body: responseBody,
        duration_ms: Date.now() - startTime
      })

      return new Response(responseBody, {
        status: responseStatus,
        headers: responseHeaders,
      })
    }

  } catch (error: unknown) {
    console.error('Proxy error:', error)
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    responseBody = JSON.stringify({ error: 'Internal Server Error' });
    responseStatus = 500;
    responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'application/json');

    // Log error
    await logToSupabase({
      ip: clientIP,
      method: req.method,
      path: req.url,
      targetUrl: targetUrl,
      request_headers: Object.fromEntries(req.headers),
      request_body: requestBody,
      response_status: responseStatus,
      response_headers: responseHeaders ? Object.fromEntries(responseHeaders) : {},
      response_body: responseBody,
      error: errorMessage,
      duration_ms: Date.now() - startTime
    })
  }

  return new Response(responseBody, {
    status: responseStatus,
    headers: responseHeaders,
  })
}