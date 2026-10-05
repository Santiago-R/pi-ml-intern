// Local token adapter; not the Chat UI configuration service.
export const config = { get GITHUB_TOKEN() { return process.env.GITHUB_TOKEN ?? ""; }, set GITHUB_TOKEN(value: string) { process.env.GITHUB_TOKEN = value; } };
