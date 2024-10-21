import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const config = {
  runtime: 'edge',
}

const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https:aaaa'
const API_KEY = process.env.API_KEY
const RATE_LIMIT_DURATION = 1000 // 2 seconds in milliseconds
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
  let targetUrl = ''; // Initialize targetUrl

  try {
    // Get the client's IP address
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip'

    // Wait for the cooldown period if necessary
    await waitForCooldown(clientIP)

    const path = req.url.split('/api/cerebras/')[1]
    targetUrl = `${TARGET_BASE_URL}/${path}` // Assign value to targetUrl

    // Clone the request headers
    const headers = new Headers(req.headers)

    // Update or add necessary headers
    headers.set('Authorization', `Bearer ${API_KEY}`)
    headers.set('Host', new URL(TARGET_BASE_URL).host)
    headers.set('Content-Type', 'application/json') // Important for tool calls

    // Remove any headers that might cause issues
    headers.delete('connection')
    headers.delete('transfer-encoding')

    // Capture request body for logging
    requestBody = await req.text();

    // Log request details to console
    console.log('Request:', {
      ip: clientIP,
      method: req.method,
      path: req.url,
      targetUrl: targetUrl, // Log the target URL
      request_headers: Object.fromEntries(req.headers),
      request_body: requestBody,
    })

    // Forward the request to Cerebras
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body, // Forward the body as-is
    })

    // Prepare response headers (Allow everything)
    responseHeaders = new Headers(response.headers)
    responseHeaders.set('Access-Control-Allow-Origin', '*')
    responseHeaders.set('Access-Control-Allow-Methods', '*')
    responseHeaders.set('Access-Control-Allow-Headers', '*')
    responseHeaders.set('Access-Control-Allow-Credentials', 'true') 
    responseHeaders.delete('transfer-encoding')
    responseHeaders.delete('connection')

    // Capture response body for logging
    responseBody = await response.text();

    // Log response details to console
    console.log('Response:', {
      response_status: response.status,
      response_headers: Object.fromEntries(response.headers),
      response_body: responseBody, 
    })

    responseStatus = response.status;

    // If the response is streaming, we need to handle it differently
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

  } catch (error: unknown) {
    console.error('Proxy error:', error)

    // Ensure error is logged even if it's not an Error instance
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log error to console
    console.error('Error details:', errorMessage);

    responseBody = JSON.stringify({ error: 'Internal Server Error' });
    responseStatus = 500;
    responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'application/json'); 
  } finally {
    // Log to Supabase regardless of success or failure 
    try {
      
      await supabase.from('api_logs').insert({
        ip: req.headers.get('x-forwarded-for') || 'unknown-ip',
        method: req.method,
        path: req.url,
        targetUrl: targetUrl, // Include targetUrl in Supabase logs
        request_headers: Object.fromEntries(req.headers),
        request_body: requestBody,
        response_status: responseStatus,
        response_headers: responseHeaders ? Object.fromEntries(responseHeaders) : {},
        response_body: responseBody,
        timestamp: new Date().toISOString(),
      })
    } catch (supabaseError) {
      console.error('Error logging to Supabase:', supabaseError)

      // Throw a console error to make it more visible (optional - remove for production)
      throw new Error(`Supabase logging failed: ${supabaseError}`);
    }
  }

  return new Response(responseBody, {
    status: responseStatus,
    headers: responseHeaders,
  })
}