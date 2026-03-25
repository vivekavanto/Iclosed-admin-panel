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
    <html lang="en">
      <head>
        <title>iClosed Admin Portal</title>
        <meta
          name="description"
          content="iClosed Admin Portal - Legal File Management"
        />
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
