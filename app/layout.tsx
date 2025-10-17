export const metadata = { title: 'MerchantPilot' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body style={{ margin: 0, background: '#f6f7f9' }}>{children}</body></html>;
}
