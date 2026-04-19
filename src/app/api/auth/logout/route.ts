// src/app/api/auth/logout/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.set('sessionId', '', {
    httpOnly: true,
    expires: new Date(0),
  });
  return response;
}