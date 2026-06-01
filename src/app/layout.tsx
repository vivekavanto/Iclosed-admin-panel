"use client";

import React from "react";
import "./globals.css";
import { NavigationProvider } from "./providers";
import ClientLayout from "./ClientLayout";
import { AuthProvider } from "@/lib/AuthProvider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <title>iClosed Admin Portal</title>
        <meta
          name="description"
          content="iClosed Admin Portal - Legal File Management"
        />
        {/* Square favicons generated from logo.png (scripts/gen-favicon.cjs)
            so the wide wordmark sits centered on a white square instead of
            being letterboxed in the browser tab. */}
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
      </head>
      <body className="antialiased">
        <AuthProvider>
          <NavigationProvider>
            <ClientLayout>{children}</ClientLayout>
          </NavigationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
