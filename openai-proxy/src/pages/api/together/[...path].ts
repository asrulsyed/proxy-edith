import { NextRequest, NextResponse } from 'next/server';

export const config = {
  runtime: 'edge',
};

const TARGET_BASE_URL = process.env.TARGET_BASE_URL_to || 'https://api.example.com';
const API_KEY = process.env.API_KEY_to;

export default async function handler(req: NextRequest) {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(req),
    });
  }

  try {
    const url = new URL(req.url);
    const targetPath = url.pathname.replace('/api/together', '');
    const targetUrl = `${TARGET_BASE_URL}${targetPath}${url.search}`;

    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${API_KEY}`);
    headers.set('Host', new URL(TARGET_BASE_URL).host);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    });

    const responseHeaders = new Headers(response.headers);
    Object.entries(corsHeaders(req)).forEach(([key, value]) => {
      responseHeaders.set(key, value);
    });

    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new NextResponse(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(req),
      },
    });
  }
}

function corsHeaders(req: NextRequest) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}