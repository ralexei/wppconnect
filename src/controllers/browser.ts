/*
 * This file is part of WPPConnect.
 *
 * WPPConnect is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * WPPConnect is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with WPPConnect.  If not, see <https://www.gnu.org/licenses/>.
 */

import * as ChromeLauncher from 'chrome-launcher';
import * as os from 'os';
import * as path from 'path';
import * as rimraf from 'rimraf';
import * as waVersion from '@wppconnect/wa-version';
import axios from 'axios';
import { Browser, BrowserContext, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import { CreateConfig } from '../config/create-config';
import { puppeteerConfig } from '../config/puppeteer.config';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { useragentOverride } from '../config/WAuserAgente';
import { WebSocketTransport } from './websocket';
import { Logger } from 'winston';
import { SessionToken } from '../token-store';
import { LoadingScreenCallback } from '../api/model';
import { LogLevel } from '../utils/logger';
import { sleep } from '../utils/sleep';

export async function unregisterServiceWorker(page: Page) {
  await page.evaluateOnNewDocument(() => {
    // Remove existent service worker
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (let registration of registrations) {
          registration.unregister();
        }
      })
      .catch((err) => null);

    // Disable service worker registration
    // @ts-ignore
    navigator.serviceWorker.register = new Promise(() => {});

    setInterval(() => {
      window.onerror = console.error;
      window.onunhandledrejection = console.error;
    }, 500);
  });
}

/**
 * Força o carregamento de uma versão específica do WhatsApp WEB
 * @param page Página a ser injetada
 * @param version Versão ou expressão semver
 */
export async function setWhatsappVersion(
  page: Page,
  version: string,
  log?: (level: LogLevel, message: string, meta?: object) => any
) {
  let body: string | null = null;
  try {
    body = waVersion.getPageContent(version);
  } catch (error) {}

  if (!body) {
    log?.(
      'error',
      `Version not available for ${version}, using latest as fallback`
    );
    return;
  }

  await page.setRequestInterception(true);

  const whatsAppUrl = puppeteerConfig.whatsappUrl;

  page.on('request', (req) => {
    if (req.url().startsWith(`${whatsAppUrl}/check-update`)) {
      req.abort();
      return;
    }
    if (req.url() !== `${whatsAppUrl}/`) {
      req.continue();
      return;
    }

    req.respond({
      status: 200,
      contentType: 'text/html',
      body: body,
    });
  });
}

export async function initWhatsapp(
  page: Page,
  token?: SessionToken,
  clear = true,
  version?: string,
  log?: (level: LogLevel, message: string, meta?: object) => any
) {
  await page.setUserAgent(useragentOverride);

  await unregisterServiceWorker(page);

  if (version) {
    log?.('verbose', `Setting WhatsApp WEB version to ${version}`);
    await setWhatsappVersion(page, version, log);
  }

  log?.('verbose', `Loading WhatsApp WEB`);
  await page.goto(puppeteerConfig.whatsappUrl, {
    waitUntil: 'load',
    timeout: 0,
    referer: 'https://whatsapp.com/',
  });
  log?.('verbose', 'WhatsApp WEB loaded');
  /*setTimeout(() => {
    log?.('verbose', `Loading WhatsApp WEB`);

    const timeout = 10 * 1000;
    page
      .goto(puppeteerConfig.whatsappUrl, {
        timeout,
        waitUntil: 'domcontentloaded',
      })
      .catch(() => {});

    log?.('verbose', `WhatsApp WEB loaded`);
  }, 1000);
  */

  return page;
}

let lastPercent = null;
let lastPercentMessage = null;
export async function onLoadingScreen(
  page: Page,
  onLoadingScreenCallBack?: LoadingScreenCallback
) {
  await page.evaluate(`function getElementByXpath(path) {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }`);

  await page
    .exposeFunction(
      'loadingScreen',
      async (percent: number, message: string) => {
        if (lastPercent !== percent || lastPercentMessage !== message) {
          onLoadingScreenCallBack && onLoadingScreenCallBack(percent, message);
          lastPercent = percent;
          lastPercentMessage = message;
        }
      }
    )
    .catch(() => null);

  await page.evaluate(
    function (selectors) {
      let observer = new MutationObserver(function () {
        let window2: any = window;

        let progressBar = window2.getElementByXpath(selectors.PROGRESS);
        let progressMessage = window2.getElementByXpath(
          selectors.PROGRESS_MESSAGE
        );

        if (progressBar) {
          if (
            this.lastPercent !== progressBar.value ||
            this.lastPercentMessage !== progressMessage.innerText
          ) {
            window2.loadingScreen(progressBar.value, progressMessage.innerText);
            this.lastPercent = progressBar.value;
            this.lastPercentMessage = progressMessage.innerText;
          }
        }
      });

      observer.observe(document, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    },
    {
      PROGRESS: "//*[@id='app']/div/div/div[2]/progress",
      PROGRESS_MESSAGE: "//*[@id='app']/div/div/div[3]",
    }
  );
}

export async function injectApi(
  page: Page,
  onLoadingScreenCallBack?: LoadingScreenCallback
) {
  const injected = await page
    .evaluate(() => {
      // @ts-ignore
      return (
        typeof window.WAPI !== 'undefined' &&
        typeof window.Store !== 'undefined'
      );
    })
    .catch(() => false);

  if (injected) {
    return;
  }
  await page.addScriptTag({
    path: require.resolve('@wppconnect/wa-js'),
  });

  await page.evaluate(() => {
    WPP.chat.defaultSendMessageOptions.createChat = true;
    WPP.conn.setKeepAlive(true);
  });
  await page.addScriptTag({
    path: require.resolve(
      path.join(__dirname, '../../dist/lib/wapi', 'wapi.js')
    ),
  });
  onLoadingScreen(page, onLoadingScreenCallBack);
}

/**
 * Initializes browser, will try to use chrome as default
 * @param session
 */
export async function initBrowser(
  session: string,
  options: CreateConfig,
  logger: Logger
): Promise<Browser> {
  if (options.useChrome) {
    const chromePath = getChrome();
    if (chromePath) {
      if (!options.puppeteerOptions) {
        options.puppeteerOptions = {};
      }
      options.puppeteerOptions.executablePath = chromePath;
    } else {
      logger.warn('Chrome not found, using chromium', {
        session,
        type: 'browser',
      });
    }
  }

  // Use stealth plugin to avoid being detected as a bot
  puppeteer.use(StealthPlugin());

  let browser = null;
  if (options.browserWS && options.browserWS != '') {
    const transport = await getTransport(options.browserWS);
    browser = await puppeteer.connect({ transport });
  } else {
    let args = options.browserArgs
      ? options.browserArgs
      : [...puppeteerConfig.chromiumArgs];

    // Replace proxy-server address with the one from environment if present
    console.log('BEFORE REPLACE');
    console.log(args);
    if (process.env.PROXY_URL) {
      console.log('REPLACING');
      args = removeBrowserArg(args, 'proxy-server');
      args.push(`--proxy-server=${process.env.PROXY_URL}`);
    }

    console.log('AFTER REPLACE');
    console.log(args);

    /**
     * Setting the headless mode to the old Puppeteer mode, when using the 'new' mode, results in an error on CentOS7 and Debian11.
     * Temporary fix.
     */
    browser = await puppeteer.launch({
      headless: options.headless,
      devtools: options.devtools,
      args: args,
      ...options.puppeteerOptions,
    });

    // Register an exit callback to remove user-data-dir
    try {
      const arg = browser
        .process()
        .spawnargs.find((s: string) => s.startsWith('--user-data-dir='));

      if (arg) {
        const tmpUserDataDir = arg.split('=')[1];

        // Only if path is in TMP directory
        if (
          path.relative(os.tmpdir(), tmpUserDataDir).startsWith('puppeteer')
        ) {
          process.on('exit', () => {
            // Remove only on exit signal
            try {
              rimraf.sync(tmpUserDataDir);
            } catch (error) {}
          });
        }
      }
    } catch (error) {}
  }

  return browser;
}

export async function getOrCreatePage(
  browser: Browser | BrowserContext
): Promise<Page> {
  const pages = await browser.pages();
  let newPage = null;
  if (pages.length) {
    newPage = pages[0];
  } else {
    newPage = await browser.newPage();
  }

  const proxyUser = process.env.PROXY_USER;
  const proxyPassword = process.env.PROXY_PWD;

  if (proxyUser && proxyPassword) {
    await newPage.authenticate({
      username: proxyUser,
      password: proxyPassword,
    });
  }

  return newPage;
}

function getBrowserArgValue(
  args: string[],
  argName: string
): string | undefined {
  if (!args || args.length == 0) {
    return undefined;
  }

  return args.find((f) => f.indexOf(argName) > -1);
}

function removeBrowserArg(args: string[], argName: string): string[] {
  if (!args || args.length == 0) {
    return args;
  }

  const indexOfArg = args.indexOf(args.find((f) => f.indexOf(argName) > -1));

  if (indexOfArg > -1) {
    args.splice(indexOfArg, 1);
  }

  return args;
}

/**
 * Retrieves chrome instance path
 */
function getChrome() {
  try {
    return ChromeLauncher.Launcher.getFirstInstallation();
  } catch (error) {
    return undefined;
  }
}

async function getTransport(browserWS: string) {
  let error = null;
  try {
    return await WebSocketTransport.create(browserWS, 10000);
  } catch (e) {
    error = e;
  }

  // Automatic get the endpoint
  try {
    const endpointURL =
      browserWS.replace(/ws(s)?:/, 'http$1:') + '/json/version';
    const data = await axios.get<any>(endpointURL).then((r) => r.data);

    return await WebSocketTransport.create(data.webSocketDebuggerUrl, 10000);
  } catch (e) {}

  // Throw first error
  throw error;
}
