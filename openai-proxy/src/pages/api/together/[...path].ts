// api/together/[...path].ts (Your Edge Function)

import { NextRequest } from 'next/server';

export const config = {
  runtime: 'edge',
};

const TARGET_BASE_URL = process.env.TARGET_BASE_URL_to || 'https:aaaa';
const API_KEY = process.env.API_KEY_to;
const RATE_LIMIT_DURATION = 10000; // 10 seconds in milliseconds

// Using a Map to store the last request time for each IP
const ipLastRequestMap = new Map<string, number>();

async function waitForCooldown(ip: string): Promise<void> {
  const lastRequestTime = ipLastRequestMap.get(ip) || 0;
  const currentTime = Date.now();
  const timeElapsed = currentTime - lastRequestTime;

  if (timeElapsed < RATE_LIMIT_DURATION) {
    const waitTime = RATE_LIMIT_DURATION - timeElapsed;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  ipLastRequestMap.set(ip, Date.now());
}

export default async function handler(req: NextRequest) {
  try {
    // Get the client's IP address
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip';

    // Wait for the cooldown period if necessary
    await waitForCooldown(clientIP);

    const path = req.url.split('/api/together/')[1];
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

    // Forward the request to the target server 
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body, // Forward the body as-is
    });

    // Prepare response headers with CORS handling
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');

    // Dynamic Origin Handling (Important for individual users)
    const origin = req.headers.get('origin');
    if (origin) {
      responseHeaders.set('Access-Control-Allow-Origin', origin);
    } else {
      // Handle cases where origin is missing (e.g., server-side scripts)
      // You can either set a default allowed origin or use '*' with caution
      responseHeaders.set('Access-Control-Allow-Origin', '*'); // Less secure, use carefully
    }

    // Other CORS headers (for non-simple requests)
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set(
      'Access-Control-Allow-Headers',
      req.headers.get('access-control-request-headers') || '*',
    );

    // Credentials (if needed)
    // If sending cookies or authentication headers, uncomment the next line:
    // responseHeaders.set('Access-Control-Allow-Credentials', 'true'); 

    // Handle preflight requests (OPTIONS)
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204, // No Content
        headers: responseHeaders,
      });
    }

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
          // Include CORS headers in error responses as well
          'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') || '*',
          // 'Access-Control-Allow-Credentials': 'true', // Uncomment if needed
        },
      },
    );
  }
}