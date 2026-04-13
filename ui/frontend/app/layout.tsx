import type { Metadata } from "next";
import "./globals.css";
import SidebarLayout from "@/components/layout/SidebarLayout";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Shinobi V3",
  description: "Call Intelligence Platform",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <Providers>
          <SidebarLayout>
            {children}
          </SidebarLayout>
        </Providers>
      </body>
    </html>
  );
}
