import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./test',outputDir:'./test-results',workers:2,forbidOnly:!!process.env.CI,
 webServer:process.env.TOASTDEX_BASE_URL?undefined:{command:'npm run dev:frontend',cwd:'..',url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:60000},
 use:{baseURL:process.env.TOASTDEX_BASE_URL??'http://127.0.0.1:5173',serviceWorkers:'block',headless:true,launchOptions:{executablePath:process.env.CHROME_BIN??(process.env.CI?undefined:'/usr/bin/google-chrome'),args:['--no-sandbox']}},timeout:45000,reporter:'list'});
