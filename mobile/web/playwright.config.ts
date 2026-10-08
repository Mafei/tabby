import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
    testDir: './tests',
    testMatch: '*.spec.ts',
    // Menu navigation adds real UI steps; gesture and protocol deadlines remain separate.
    timeout: 40_000,
    fullyParallel: true,
    workers: 2,
    reporter: [['list'], ['html', { outputFolder: '../test-results/web-report', open: 'never' }]],
    outputDir: '../test-results/web',
    use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
        baseURL: 'http://127.0.0.1:4173',
        launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4173/tests/harness.html',
        reuseExistingServer: false, timeout: 120_000 },
})
