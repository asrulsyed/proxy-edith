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
const MONITORING_PERIOD = 10 * 60 * 1000 // 10 minutes
const REQUEST_THRESHOLD = 2 // Notify after 2 requests

// Initialize Telegram bot
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
}

interface RequestTracker {
  count: number
  firstRequestTime: number
  lastNotificationTime?: number
}

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// In-memory storage
const ipLastRequestMap = new Map<string, number>()
const ipRequestCountMap = new Map<string, RequestTracker>()
const BANNED_IPS = ['194.191.253.202']
const RATE_LIMIT_DURATION = 1000 // 1 second

// Helper functions
function isBannedIP(ip: string): boolean {
  return BANNED_IPS.includes(ip)
}

async function notifyAdmin(ip: string, requestTracker: RequestTracker): Promise<void> {
  const currentTime = Date.now()
  const lastNotificationTime = requestTracker.lastNotificationTime || 0

  // Only send notification if we haven't sent one in the last monitoring period
  if (currentTime - lastNotificationTime >= MONITORING_PERIOD) {
    try {
      const message = `🚨 High Traffic Alert!
IP Address: ${ip}
Request Count: ${requestTracker.count} requests
Time Window: Last 10 minutes
First Request: ${new Date(requestTracker.firstRequestTime).toISOString()}
Current Time: ${new Date().toISOString()}`

      await bot.api.sendMessage(TELEGRAM_CHAT_ID, message)
      requestTracker.lastNotificationTime = currentTime
    } catch (error) {
      console.error('Failed to send Telegram notification:', error)
    }
  }
}

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

async function logToSupabase(data: LogEntry): Promise<void> {
  try {
    const { error } = await supabase
      .from('api_logs')
      .insert([{
        ip: data.ip,
        method: data.method,
        path: data.path,
        target_url: data.target_url,
        request_headers: data.request_headers,
        request_body: data.request_body,
        response_status: data.response_status,
        response_headers: data.response_headers,
        response_body: data.response_body,
        error: data.error,
        duration_ms: data.duration_ms
      }])

    if (error) {
      console.error('Supabase logging error:', error)
    }
  } catch (error) {
    console.error('Failed to log to Supabase:', error)
  }
}

export default async function handler(req: NextRequest) {
  const startTime = Date.now()
  const clientIP = req.headers.get('x-forwarded-for') || 'unknown-ip'
  
  // Initialize logging variables
  let requestBody = ''
  let responseBody = ''
  let responseStatus = 500
  let responseHeaders: Record<string, string> = {}
  let targetUrl = ''
  let error: string | undefined

  try {
    // Origin check
    const origin = req.headers.get('origin')
    const referer = req.headers.get('referer')
    const host = origin || referer

    if (!host?.includes('chat.gaurish.xyz') && !host?.includes('gaurish.xyz')) {
      responseStatus = 403
      responseBody = 'Unauthorized Origin'
      
      await logToSupabase({
        ip: clientIP,
        method: req.method,
        path: req.url,
        target_url: '',
        request_headers: Object.fromEntries(req.headers),
        request_body: '',
        response_status: responseStatus,
        response_headers: {},
        response_body: responseBody,
        error: 'Unauthorized origin',
        duration_ms: Date.now() - startTime
      })

      return new Response(responseBody, {
        status: responseStatus,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': '*'
        }
      })
    }

    // Check if IP is banned
    if (isBannedIP(clientIP)) {
      responseStatus = 403
      responseBody = 'Your IP is banned from accessing this service.'
      
      await logToSupabase({
        ip: clientIP,
        method: req.method,
        path: req.url,
        target_url: '',
        request_headers: Object.fromEntries(req.headers),
        request_body: '',
        response_status: responseStatus,
        response_headers: {},
        response_body: responseBody,
        error: 'Banned IP',
        duration_ms: Date.now() - startTime
      })

      return new Response(responseBody, {
        status: responseStatus,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': '*'
        }
      })
    }

    // Rate limiting
    await waitForCooldown(clientIP)

    // Track and monitor requests
    const currentTime = Date.now()
    const requestTracker = ipRequestCountMap.get(clientIP) || {
      count: 0,
      firstRequestTime: currentTime
    }

    // Reset counter if monitoring period has passed
    if (currentTime - requestTracker.firstRequestTime > MONITORING_PERIOD) {
      requestTracker.count = 1
      requestTracker.firstRequestTime = currentTime
    } else {
      requestTracker.count++
    }

    // Check if threshold is exceeded
    if (requestTracker.count > REQUEST_THRESHOLD) {
      await notifyAdmin(clientIP, requestTracker)
    }

    ipRequestCountMap.set(clientIP, requestTracker)

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
    outgoingHeaders.set('Access-Control-Allow-Origin', '*')
    outgoingHeaders.set('Access-Control-Allow-Methods', '*')
    outgoingHeaders.set('Access-Control-Allow-Headers', '*')
    outgoingHeaders.set('Access-Control-Allow-Credentials', 'true')
    outgoingHeaders.delete('transfer-encoding')
    outgoingHeaders.delete('connection')

    responseStatus = response.status
    responseHeaders = Object.fromEntries(outgoingHeaders)

    // Handle streaming responses
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
        target_url: targetUrl,
        request_headers: Object.fromEntries(req.headers),
        request_body: requestBody,
        response_status: responseStatus,
        response_headers: responseHeaders,
        response_body: '[Streaming Response]',
        duration_ms: Date.now() - startTime
      })

      return new Response(streamedResponse, {
        status: responseStatus,
        headers: outgoingHeaders,
      })
    }

    // Handle regular responses
    responseBody = await response.text()
    
    // Log regular request
    await logToSupabase({
      ip: clientIP,
      method: req.method,
      path: req.url,
      target_url: targetUrl,
      request_headers: Object.fromEntries(req.headers),
      request_body: requestBody,
      response_status: responseStatus,
      response_headers: responseHeaders,
      response_body: responseBody,
      duration_ms: Date.now() - startTime
    })

    return new Response(responseBody, {
      status: responseStatus,
      headers: outgoingHeaders,
    })

  } catch (e) {
    error = e instanceof Error ? e.message : 'Unknown error'
    console.error('Proxy error:', error)
    
    responseStatus = 500
    responseBody = JSON.stringify({ error: 'Internal Server Error' })
    responseHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*'
    }

    // Log error
    await logToSupabase({
      ip: clientIP,
      method: req.method,
      path: req.url,
      target_url: targetUrl,
      request_headers: Object.fromEntries(req.headers),
      request_body: requestBody,
      response_status: responseStatus,
      response_headers: responseHeaders,
      response_body: responseBody,
      error: error,
      duration_ms: Date.now() - startTime
    })

    return new Response(responseBody, {
      status: responseStatus,
      headers: responseHeaders
    })
  }
}