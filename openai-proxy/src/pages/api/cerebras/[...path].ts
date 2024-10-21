import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const config = {
  runtime: 'edge',
};

const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://aaaa';
const API_KEY = process.env.API_KEY;
const RATE_LIMIT_DURATION = 1000; // 2 seconds in milliseconds
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Using a Map to store the last request time for each IP
const ipLastRequestMap = new Map<string, number>();

async function waitForCooldown(ip: string): Promise<void> {
  const lastRequestTime = ipLastRequestMap.get(ip) || 0;
  const currentTime = Date.now();
  const timeElapsed = currentTime - lastRequestTime;
  if (timeElapsed < RATE_LIMIT_DURATION) {
    const waitTime = RATE_LIMIT_DURATION - timeElapsed;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  ipLastRequestMap.set(ip, Date.now());
}

async function logRequest(ip: string, request: NextRequest, response: Response) {
  const { data, error } = await supabase
    .from('request_logs')
    .insert({
      ip: ip,
      method: request.method,
      path: request.url,
      request_headers: Object.fromEntries(request.headers),
      request_body: await request.text(),
      response_status: response.status,
      response_headers: Object.fromEntries(response.headers),
      response_body: await response.text(),
      timestamp: new Date().toISOString(),
    });

  if (error) {
    console.error('Error logging request:', error);
  }
}

export default async function handler(req: NextRequest) {
  try {
    // Get the client's IP address
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip';

    // Wait for the cooldown period if necessary
    await waitForCooldown(clientIP);

    const path = req.url.split('/api/cerebras/')[1];
    const targetUrl = `${TARGET_BASE_URL}/${path}`;

    // Clone the request headers
    const headers = new Headers(req.headers);

    // Update or add necessary headers
    headers.set('Authorization', `Bearer ${API_KEY}`);
    headers.set('Host', new URL(TARGET_BASE_URL).host);
    headers.set('Content-Type', 'application/json'); // Important for tool calls

    // Remove any headers that might cause issues
    headers.delete('connection');
    headers.delete('transfer-encoding');

    // Forward the request to Cerebras
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body, // Forward the body as-is
    });

    // Prepare response headers
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');

    // Clone the response for logging
    const responseForLogging = response.clone();

    // Log the request and response
    await logRequest(clientIP, req, responseForLogging);

    // If the response is streaming, we need to handle it differently
    const isStreaming = response.headers.get('content-type')?.includes('stream');
    if (isStreaming) {
      // For streaming responses, create a TransformStream to process chunks
      const transformStream = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      });

      // Pipe the response body through our transform stream
      const streamedResponse = response.body?.pipeThrough(transformStream);
      if (!streamedResponse) {
        throw new Error('No response body');
      }

      // Return a streaming response
      return new Response(streamedResponse, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // For non-streaming responses, forward as-is
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
}