import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function POST(request: NextRequest) {
  console.log('🔥 API route called - POST /api/projects/create') // Updated with profile creation
  
  try {
    console.log('📝 Creating Supabase client...')
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            // For API routes, we don't need to set cookies in the response
            // The browser will handle cookie management
          },
        },
      }
    )

    // Create service role client for database operations (bypasses RLS temporarily)
    console.log('🔧 Service role key present:', !!process.env.SUPABASE_SERVICE_ROLE_KEY)
    console.log('🔧 Supabase URL:', process.env.NEXT_PUBLIC_SUPABASE_URL)
    console.log('🔧 Anon key present:', !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    console.log('🔧 Service key prefix:', process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 20) + '...')
    console.log('🔧 Anon key prefix:', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.substring(0, 20) + '...')
    
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('❌ SUPABASE_SERVICE_ROLE_KEY is missing!')
      return NextResponse.json(
        { error: 'Server configuration error: Missing service role key' },
        { status: 500 }
      )
    }
    
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      console.error('❌ NEXT_PUBLIC_SUPABASE_URL is missing!')
      return NextResponse.json(
        { error: 'Server configuration error: Missing Supabase URL' },
        { status: 500 }
      )
    }
    
    const supabaseService = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll: () => [],
          setAll: () => {},
        },
      }
    )

    console.log('🔐 Checking authentication...')
    console.log('=== API Auth Debug ===')
    console.log('Cookies received:', request.cookies.getAll().map(c => ({ name: c.name, hasValue: !!c.value })))
    
    // Get authenticated user
    let user: any = null
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser()
      user = authData.user
      
      console.log('User:', user?.id)
      console.log('Auth Error:', authError?.message)
      console.log('Final auth status:', user ? 'Authenticated' : 'Not authenticated')
      console.log('====================')
      
      if (authError || !user) {
        console.log('❌ Auth failed:', authError?.message || 'No user')
        const response = NextResponse.json(
          { error: 'Unauthorized', details: authError?.message || 'No user found' },
          { status: 401 }
        )
        console.log('📤 Returning 401 response')
        return response
      }

      console.log('✅ Authentication successful for user:', user.id)
    } catch (authException) {
      console.error('🚨 Auth exception:', authException)
      return NextResponse.json(
        { 
          error: 'Authentication failed', 
          details: authException instanceof Error ? authException.message : 'Unknown auth error',
          step: 'auth_exception'
        },
        { status: 500 }
      )
    }
    console.log('🔍 PROFILE CHECK STARTING...')

    // Ensure user has a profile record (with retry logic for auto-trigger timing)
    console.log('👤 Checking user profile...')
    let existingProfile = null
    
    // First attempt with regular client
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, role, display_name')
      .eq('id', user.id)
      .single()
    
    if (profile) {
      existingProfile = profile
      console.log('✅ Profile found with regular client:', existingProfile)
    } else {
      // Fallback with service client
      const { data: serviceProfile } = await supabaseService
        .from('profiles')
        .select('id, role, display_name')
        .eq('id', user.id)
        .single()
      
      if (serviceProfile) {
        existingProfile = serviceProfile
        console.log('✅ Profile found with service client:', existingProfile)
      }
    }

    console.log('🔍 Final profile result:', existingProfile)

    if (!existingProfile) {
      console.log('❌ No profile found - this should not happen for existing users')
      return NextResponse.json(
        { 
          error: 'User profile not found. Please refresh the page or contact support.',
          details: `User ID: ${user.id}`,
          suggestion: 'Try refreshing the page or signing out and back in.'
        },
        { status: 500 }
      )
    }
    
    // Check if user has permission to create projects
    if (existingProfile.role?.toLowerCase() === 'reader') {
      return NextResponse.json(
        { 
          error: 'Permission denied', 
          message: 'Readers cannot create projects. Please upgrade to Writer role in settings.',
          upgradeRequired: true
        },
        { status: 403 }
      )
    }

    console.log('✅ User profile verified - role:', existingProfile.role)
    console.log('🔍 PROFILE CHECK COMPLETE...')

    console.log('📥 Parsing request body...')
    const body = await request.json()
    console.log('📋 Request data received:', Object.keys(body))
    
    const {
      title,
      logline,
      description,
      format,
      genre,
      visibility = 'private',
      ai_enabled = true,
      ip_protection_enabled = true
    } = body

    // Validate required fields
    if (!title?.trim()) {
      return NextResponse.json(
        { error: 'Title is required' },
        { status: 400 }
      )
    }

    if (!logline?.trim()) {
      return NextResponse.json(
        { error: 'Logline is required' },
        { status: 400 }
      )
    }

    if (!format) {
      return NextResponse.json(
        { error: 'Format is required' },
        { status: 400 }
      )
    }

    console.log('🏗️ Creating project in database...')
    // Create project (matching actual database schema) - using service role to bypass RLS temporarily
    const { data: project, error: projectError } = await supabaseService
      .from('projects')
      .insert({
        title: title.trim(),
        logline: logline.trim(),
        synopsis: description?.trim() || null, // Database has 'synopsis', not 'description'
        format,
        genre: genre || null,
        visibility,
        owner_id: user.id,
        buzz_score: 0
        // Note: ai_enabled and ip_protection_enabled not in database schema
      })
      .select()
      .single()

    if (projectError) {
      console.error('💥 Project creation error:', projectError)
      return NextResponse.json(
        { error: 'Failed to create project', details: projectError.message },
        { status: 500 }
      )
    }

    console.log('✅ Project created successfully:', project.id)

    // Create IP timestamp if enabled (only if table exists)
    if (ip_protection_enabled) {
      console.log('🔒 Creating IP protection timestamp...')
      
      // Generate content hash for IP protection
      const contentToHash = `${title.trim()}\n${logline.trim()}\n${description?.trim() || ''}`
      const contentHash = Buffer.from(contentToHash).toString('base64')
      
      const { error: timestampError } = await supabaseService
        .from('ip_timestamps')
        .insert({
          project_id: project.id,
          content_hash: contentHash,
          provider: 'local'
        })

      if (timestampError) {
        console.error('⚠️ IP timestamp creation failed:', timestampError)
        // Don't fail the entire request for IP timestamp issues
      } else {
        console.log('✅ IP timestamp created successfully')
      }
    }

    return NextResponse.json({
      success: true,
      project
    })

  } catch (error) {
    console.error('🚨 FATAL API ERROR:', error)
    console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace available')
    console.error('Error name:', error instanceof Error ? error.name : 'Unknown')
    console.error('Error message:', error instanceof Error ? error.message : 'Unknown error')
    
    // Log environment variables status for debugging
    console.error('Environment check:', {
      supabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      serviceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      nodeEnv: process.env.NODE_ENV
    })
    
    // Always return valid JSON response
    const response = NextResponse.json(
      { 
        error: 'Failed to create project', 
        details: error instanceof Error ? error.message : 'Unknown error',
        errorType: error instanceof Error ? error.name : 'Unknown',
        timestamp: new Date().toISOString(),
        debug: {
          hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
          hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      },
      { status: 500 }
    )
    
    console.log('📤 Returning 500 error response')
    return response
  }
}
