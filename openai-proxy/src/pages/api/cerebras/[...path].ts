import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Bot } from 'grammy'


export const config = {
  runtime: 'edge',
}

// Environment variables
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || ""
const API_KEY = process.env.API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ""
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ""

// Initialize services
const bot = new Bot(TELEGRAM_BOT_TOKEN)


// Verify required environment variables
if (!TARGET_BASE_URL) throw new Error('TARGET_BASE_URL is required')
if (!API_KEY) throw new Error('API_KEY is required')
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required')
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is required')
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required')
if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required')

// Types
interface LogEntry {
  ip: string
  method: string
  path: string
  target_url: string
  request_headers: Record<string, string>
  request_body: string
  response_status: number
  response_headers: Record<string, string>
  response_body: string
  error?: string
  duration_ms: number
  country?: string
}

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const BANNED_IPS = ['194.191.253.202']
// Rate limiting map
const requestTimes = new Map<string, number>()

function isBannedIP(ip: string): boolean {
  return BANNED_IPS.includes(ip)
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const lastRequest = requestTimes.get(ip) || 0

  if (now - lastRequest < 200) { // 200 ms rate limit
    return true
  }

  requestTimes.set(ip, now)
  return false
}

async function notifyAdmin(ip: string, method: string, path: string): Promise<void> {
  try {
    const message = `🌐 New Request Alert!
IP: ${ip}
Method: ${method}
Path: ${path}
Time: ${new Date().toISOString()}`

    // Fire and forget - don't await
    bot.api.sendMessage(TELEGRAM_CHAT_ID, message)
      .catch(error => console.error('Telegram notification error:', error))
  } catch (error) {
    console.error('Failed to send Telegram notification:', error)
  }
}

async function logToSupabase(data: LogEntry): Promise<void> {
  try {
    const { error } = await supabase
      .from('api_logs')
      .insert([data])

    if (error) {
      console.error('Supabase logging error:', error)
    }
  } catch (error) {
    console.error('Failed to log to Supabase:', error)
  }
}

async function handleError(
  req: NextRequest,
  clientIP: string,
  startTime: number,
  status: number,
  errorMessage: string,
  targetUrl = ''
): Promise<Response> {
  const responseBody = JSON.stringify({ error: errorMessage })
  const responseHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*'
  }

  // Fire and forget notification
  notifyAdmin(clientIP, req.method, req.url)

  // Fire and forget logging
  logToSupabase({
    ip: clientIP,
    method: req.method,
    path: req.url,
    target_url: targetUrl,
    request_headers: Object.fromEntries(req.headers),
    request_body: '',
    response_status: status,
    response_headers: responseHeaders,
    response_body: responseBody,
    error: errorMessage,
    duration_ms: Date.now() - startTime,
  })

  return new Response(responseBody, {
    status,
    headers: responseHeaders
  })
}

export default async function handler(req: NextRequest) {
  const startTime = Date.now()
  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown-ip'


  try {
    // Origin check
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': 'https://mvp-edith.vercel.app',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    }
    const origin = req.headers.get('origin')
    const referer = req.headers.get('referer')
    const host = origin || referer

    if (!host?.includes('chat.gaurish.xyz') && !host?.includes('gaurish.xyz') && !host?.includes('mvp-edith.vercel.app')) {
      return handleError(req, clientIP, startTime, 403, 'Unauthorized Origin')
    }

    // Check if IP is banned
    if (isBannedIP(clientIP)) {
      return handleError(req, clientIP, startTime, 403, 'Your IP is banned from accessing this service')
    }

    // Check rate limit
    if (isRateLimited(clientIP)) {
      return handleError(req, clientIP, startTime, 429, 'Too Many Requests')
    }

    // Initialize logging variables
    let requestBody = ''
    let responseBody = ''
    let responseStatus = 500
    let responseHeaders: Record<string, string> = {}
    let targetUrl = ''
    let error: string | undefined

    // Prepare request
    const path = req.url.split('/api/cerebras/')[1]
    if (!path) {
      throw new Error('Invalid path')
    }

    targetUrl = `${TARGET_BASE_URL}/${path}`
    requestBody = await req.text()

    // Prepare headers
    const headers = new Headers(req.headers)
    headers.set('Authorization', `Bearer ${API_KEY}`)
    headers.set('Host', new URL(TARGET_BASE_URL).host)
    headers.set('Content-Type', 'application/json')
    headers.delete('connection')
    headers.delete('transfer-encoding')

    // Make the request
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: requestBody || undefined,
    })

    // Prepare response headers
    const outgoingHeaders = new Headers(response.headers)
    outgoingHeaders.set('Access-Control-Allow-Origin', 'https://mvp-edith.vercel.app')
    outgoingHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    outgoingHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    outgoingHeaders.set('Access-Control-Allow-Credentials', 'true')
    outgoingHeaders.delete('transfer-encoding')
    outgoingHeaders.delete('connection')

    responseStatus = response.status
    responseHeaders = Object.fromEntries(outgoingHeaders)


    // Fire and forget notification for every request
    notifyAdmin(clientIP, req.method, req.url)

    // Handle streaming responses
    const isStreaming = response.headers.get('content-type')?.includes('stream')
    if (isStreaming) {
      const streamedResponse = response.body
      if (!streamedResponse) {
        throw new Error('No response body')
      }

      // Fire and forget logging
      logToSupabase({
        ip: clientIP,
        method: req.method,
        path: req.url,
        target_url: targetUrl,
        request_headers: Object.fromEntries(req.headers),
        request_body: requestBody,
        response_status: responseStatus,
        response_headers: responseHeaders,
        response_body: '[Streaming Response]',
        duration_ms: Date.now() - startTime,
      })

      return new Response(streamedResponse, {
        status: responseStatus,
        headers: outgoingHeaders,
      })
    }

    // Handle regular responses
    responseBody = await response.text()

    // Fire and forget logging
    logToSupabase({
      ip: clientIP,
      method: req.method,
      path: req.url,
      target_url: targetUrl,
      request_headers: Object.fromEntries(req.headers),
      request_body: requestBody,
      response_status: responseStatus,
      response_headers: responseHeaders,
      response_body: responseBody,
      duration_ms: Date.now() - startTime,
    })

    return new Response(responseBody, {
      status: responseStatus,
      headers: outgoingHeaders,
    })

  } catch (e) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    console.error('Proxy error:', error)

    return handleError(req, clientIP, startTime, 500, 'Internal Server Error')
  }
}

