import { NextRequest } from 'next/server';

export const config = {
  runtime: 'edge',
};

const TARGET_BASE_URL = process.env.TARGET_BASE_URL_to || 'https:aaaa';
const API_KEY = process.env.API_KEY_to;
const RATE_LIMIT_DURATION = 10000; // 10 seconds in milliseconds

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

function setCORSHeaders(req: NextRequest, headers: Headers) {
  const origin = req.headers.get('origin');
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Allow-Credentials', 'true');
}

export default async function handler(req: NextRequest) {
  try {
    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip';
    await waitForCooldown(clientIP);

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      const headers = new Headers();
      setCORSHeaders(req, headers);
      return new Response(null, { status: 204, headers });
    }

    const path = req.url.split('/api/together/')[1];
    const targetUrl = `${TARGET_BASE_URL}/${path}`;

    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${API_KEY}`);
    headers.set('Host', new URL(TARGET_BASE_URL).host);
    headers.set('Content-Type', 'application/json');
    headers.delete('connection');
    headers.delete('transfer-encoding');

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');
    setCORSHeaders(req, responseHeaders);

    const isStreaming = response.headers.get('content-type')?.includes('stream');
    if (isStreaming) {
      const transformStream = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      });

      const streamedResponse = response.body?.pipeThrough(transformStream);
      if (!streamedResponse) {
        throw new Error('No response body');
      }

      return new Response(streamedResponse, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    const errorHeaders = new Headers();
    setCORSHeaders(req, errorHeaders);
    errorHeaders.set('Content-Type', 'application/json');
    return new Response(
      JSON.stringify({ error: 'Internal Server Error' }),
      {
        status: 500,
        headers: errorHeaders,
      }
    );
  }
}