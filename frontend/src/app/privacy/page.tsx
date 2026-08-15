export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: June 25, 2026</em></p>
      <h2>Data We Collect</h2>
      <p>This application only stores the minimum data required to function:</p>
      <ul>
        <li>Account credentials (API tokens, OAuth tokens) for posting to social media platforms</li>
        <li>Content metadata (video titles, descriptions, schedules)</li>
        <li>Usage logs for debugging and monitoring</li>
      </ul>
      <h2>How We Use Your Data</h2>
      <p>Your data is used solely to automate social media posting on your behalf. We do not sell, share, or distribute your data to third parties.</p>
      <h2>Data Storage</h2>
      <p>All data is stored in Cloudflare D1 database (Asia-Pacific region). OAuth tokens are encrypted at rest.</p>
      <h2>Contact</h2>
      <p>For questions, reach out via the repository: github.com/waqaskhan1437/waqas-ai-studio</p>
    </main>
  );
}
