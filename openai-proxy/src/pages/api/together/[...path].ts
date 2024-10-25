import { NextRequest, NextResponse } from 'next/server';

export const config = {
  runtime: 'edge',
};

const TARGET_BASE_URL = process.env.TARGET_BASE_URL_to || 'https://api.example.com';
const API_KEY = process.env.API_KEY_to;

const BANNED_IPS = ['194.191.253.202'];

function isBannedIP(ip: string): boolean {
  return BANNED_IPS.includes(ip);
}

async function notifyAdmin(ip: string): Promise<void> {
  // Implement your notification logic here
  console.log(`Admin notification: IP ${ip} has exceeded the request limit.`);
}

const ipLastRequestMap = new Map<string, number>();
const ipRequestCountMap = new Map<string, { count: number, firstRequestTime: number }>();

async function waitForCooldown(ip: string): Promise<void> {
  const lastRequestTime = ipLastRequestMap.get(ip) || 0;
  const currentTime = Date.now();
  const timeElapsed = currentTime - lastRequestTime;

  if (timeElapsed < 1000) {
    const waitTime = 1000 - timeElapsed;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  ipLastRequestMap.set(ip, Date.now());
}

export default async function handler(req: NextRequest) {
  const diagnosticInfo: string[] = [];

  try {
    // Log request details
    diagnosticInfo.push(`Method: ${req.method}`);
    diagnosticInfo.push(`URL: ${req.url}`);

    if (req.method === 'OPTIONS') {
      return new NextResponse(null, {
        status: 204,
        headers: {
          ...corsHeaders(req),
          'X-Proxy-Diagnostic': diagnosticInfo.join('; '),
        },
      });
    }

    const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip';

    // Check if IP is banned
    if (isBannedIP(clientIP)) {
      return new NextResponse('Your IP is banned from accessing this service.', {
        status: 403,
        headers: corsHeaders(req),
      });
    }

    await waitForCooldown(clientIP);

    // Track request count
    const currentTime = Date.now();
    const requestCountData = ipRequestCountMap.get(clientIP) || { count: 0, firstRequestTime: currentTime };
    requestCountData.count += 1;

    if (currentTime - requestCountData.firstRequestTime > 5 * 60 * 1000) {
      // Reset count if more than 5 minutes have passed
      requestCountData.count = 1;
      requestCountData.firstRequestTime = currentTime;
    }

    if (requestCountData.count > 10) {
      await notifyAdmin(clientIP);
    }

    ipRequestCountMap.set(clientIP, requestCountData);

    const url = new URL(req.url);
    const targetPath = url.pathname.replace('/api/proxy', '');
    const targetUrl = `${TARGET_BASE_URL}${targetPath}${url.search}`;
    diagnosticInfo.push(`Target URL: ${targetUrl}`);

    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${API_KEY}`);
    headers.set('Host', new URL(TARGET_BASE_URL).host);

    diagnosticInfo.push('Sending request to target');
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    });
    diagnosticInfo.push(`Target response status: ${response.status}`);

    const responseHeaders = new Headers(response.headers);
    Object.entries(corsHeaders(req)).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });
    responseHeaders.set('X-Proxy-Diagnostic', diagnosticInfo.join('; '));

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    diagnosticInfo.push(`Error: ${error.message}`);
    return new NextResponse(JSON.stringify({ 
      error: 'Internal Server Error',
      diagnostics: diagnosticInfo 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(req),
        'X-Proxy-Diagnostic': diagnosticInfo.join('; '),
      },
    });
  }
}

function corsHeaders(req: NextRequest) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}
