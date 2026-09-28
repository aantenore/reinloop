// Plugin example: a middleware that masks secrets in tool output before the model sees them.
const PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/g, /AKIA[0-9A-Z]{16}/g, /ghp_[A-Za-z0-9]{36}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g];

export default function register(registry) {
  registry.middleware.set('redact-secrets', () => ({
    name: 'redact-secrets',
    afterTool(result) {
      const content = PATTERNS.reduce((text, re) => text.replace(re, '[REDACTED]'), result.content);
      return content === result.content ? undefined : { ...result, content };
    },
  }));
}
