"use client";

import React from "react";
import "./globals.css";
import { NavigationProvider } from "./providers";
import Sidebar from "../components/Sidebar";
import SearchDrawer from "../components/SearchDrawer";
import ClientLayout from "./ClientLayout";

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
        <NavigationProvider>
          <ClientLayout>{children}</ClientLayout>
        </NavigationProvider>
      </body>
    </html>
  );
}
