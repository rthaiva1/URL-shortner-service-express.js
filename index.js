#!/usr/bin/env nodejs

'use strict';

const assert = require('assert');
const Path = require('path');
const process = require('process');
const { promisify } = require('util');
const readFile = promisify(require('fs').readFile);

const shortenerServices = require('./shortener-ws');
const Shortener = require('./url-shortener');

function usage() {
  const prog = Path.basename(process.argv[1]);
  console.error(`usage: ${prog} MONGODB_URL PORT [LONG_URL...]`);
  process.exit(1);
}

function getPort(portArg) {
  let port = Number(portArg);
  if (!port) usage();
  return port;
}

const BASE = '';

//Time after which db should be reset
const CLEAR_TIME_MILLIS = Number(process.env.SHORTENER_CLEAR_TIME)*1000 || -1;
const DOMAIN = process.env.SHORTENER_DOMAIN || 'localhost';

async function go(args) {
  try {
    const port = getPort(args[1]);
    const shortener = await Shortener.make(args[0], `${DOMAIN}:${port}`);
    if (args.length > 2) {
      shortener.clear();
      for (let i = 2; i < args.length; i++) {
	const result = await shortener.add(args[i]);
	console.log(`${args[i]} => ${result.value}`);
      }
    }
    shortenerServices.serve(port, BASE, shortener);
    if (CLEAR_TIME_MILLIS > 0) {
      const resetFn = async () => { console.log('clear'); await shortener.clear() };
      setInterval(resetFn, CLEAR_TIME_MILLIS)
    }
  }
  catch (err) {
    console.error(err);
  }
}
    

if (process.argv.length < 4) usage();
go(process.argv.slice(2));
