import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./test',outputDir:'./test-results',use:{baseURL:'http://127.0.0.1:5173',headless:true,launchOptions:{executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']}},timeout:45000,reporter:'list'});
