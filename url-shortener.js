'use strict';

const lib544 = require('lib544');

const { isDomainError: isBaseError } = lib544;

const assert = require('assert');
const mongo = require('mongodb').MongoClient;

class UrlShortener {

  /**
   *  The return value for each of the following methods must be an
   *  object.  If an error is detected, then an exception must be
   *  thrown.  The exception should be an object having at least the
   *  following 2 properties:
   *
   *   'code':   A short string which specifies the class of error
   *             which occurred.
   *   'message':A detailed string describing the error in as much
   *             detail as possible.
   *
   *  The specifications for the methods below specify the 'code'; the
   *  'message' can be any suitable description of the error.  The
   *  intent is that the 'code' property is suitable for use by
   *  machines while the 'message' property is suitable for use by
   *  humans.
   *
   *  When a URL is deactivated, any association for that URL is
   *  merely deactivated and not removed.  While deactivated, the
   *  association is not returned by the `query()` method until it is
   *  added again using the `add()` method.
   */

  /** Factory method for building a URL shortener with specified mongoDbUrl
   *  and shortenerBase.
   *
   *  The mongoDbUrl parameter must be a valid URL with scheme set
   *  to mongodb.
   *
   * The shortenerBase parameter must consists of a valid domain followed
   * by an optional port.
   *
   * If everything is ok, this factory method should return a new
   * instance of this.
   *
   * If an error occurs, then an exception is thrown. The following
   * error codes are defined for errors explicitly checked for:
   *
   *   BAD_MONGO_URL: mongodbUrl is invalid.
   *   BAD_SHORTENER_BASE: shortenerBase is invalid.
   */
  static async make(mongoDbUrl, shortenerBase) {
    const components = splitUrl(mongoDbUrl);
    if (components.error) {
      throw makeError('BAD_MONGO_URL', components.error.message);
    }
    if (components.scheme !== 'mongodb') {
      const msg = `bad scheme "${components.scheme}"; must be "mongodb"`;
      throw makeError('BAD_MONGO_URL', msg);
    }
    const mongoUrl = `mongodb://${components.domain}`;
    const db = components.rest.slice(1);
    const err = isBaseError(shortenerBase);
    if (err) throw makeError('BAD_SHORTENER_BASE', err);
    const client = await mongo.connect(mongoDbUrl, MONGO_OPTIONS);
    return new UrlShortener(shortenerBase, client, db);
  }

  /** Create a URL shortener with SHORTENER_BASE set to base. */
  constructor(base, client, db) {
    this.base = base.toLowerCase();
    this.client = client;
    const dbConn = client.db(db);
    for (const [k, v] of Object.entries(COLLECTIONS)) {
      this[k] = dbConn.collection(v);
    }
  }

  /** Release all resources held by this url-shortener.  Specifically,
   *  close any database connections.  Return empty object.
   */
  async close() {
    await this.client.close();
  }

  /** Clear database */
  async clear() {
    for (const [k, v] of Object.entries(COLLECTIONS)) {
      await this[k].deleteMany({});
    }
    return {}
  }


  /** The argument longUrl must be a legal url.  It is ok if it has
   *  been previously added or deactivated.  The base of longUrl cannot
   *  be the same as the base of this url-shortener.
   *
   *  If there are no errors, then return an object having a 'value'
   *  property which contains the short url corresponding to longUrl.
   *  If longUrl was previously added, then the short url *must* be
   *  the same as the previously returned value.  If long url is
   *  currently deactivated, then it's previous association is made
   *  available to subsequent uses of the query() method.
   *
   * If an error occurs, then an exception is thrown. The following
   * error codes are defined for errors explicitly checked for:
   *
   *   'URL_SYNTAX': longUrl syntax is incorrect (it does not contain
   *                 a :// substring, its domain is invalid).
   *
   *   'DOMAIN':     base of longUrl is equal to shortUrl base.
   */
  async add(longUrl) {
    const components = splitUrl(longUrl, /^https?$/i);
    if (components.error) throw makeError(components.error);
    if (components.base === this.base) {
      const msg = `url ${longUrl} has same base ${this.base} as shortener`;
      throw makeError('DOMAIN', msg);
    }
    let info = await this._lookupInfo(components);
    if (!info) {
      const longKey = `${components.base}${components.rest}`;
      let shortKey;
      do { //ensure shortKey not previously generated
	shortKey = this._shorten(components);
      } while (await this.infos.findOne({_id: shortKey}));
      info = {
	_id: shortKey,
	longUrl: longKey,
	shortUrl: shortKey,
	count: 0,
	isActive: true,
      };
      await this.infos.insertOne(info);
      await this.urls.insertOne({_id: longKey, shortUrl: shortKey});
    }
    if (!info.isActive) await this._setActiveStatus(info, true);
    return { value: `${components.scheme}://${info.shortUrl}` };
  }

  /** The argument shortUrl must be a shortened URL previously
   *  returned by the add() method which has not subsequently been
   *  deactivated by the deactivate() method.
   *
   *  If there are no errors, then return an object having a 'value'
   *  property which contains the long url corresponding to shortUrl.
   *
   * If an error occurs, then an exception is thrown. The following
   * error codes are defined for errors explicitly checked for:
   *
   *   'URL_SYNTAX': shortUrl syntax is incorrect (it does not contain
   *                 a :// substring or the base is invalid.
   *
   *   'DOMAIN':     shortUrl base is not equal to SHORTENER_BASE.
   *
   *   'NOT_FOUND':  shortUrl is not currently registered for this
   *                 service.
   */
  async query(shortUrl) {
    const components = splitUrl(shortUrl, /^https?$/i);
    if (components.error) throw makeError(components.error);
    if (this.base !== components.base) {
      const msg = `url ${shortUrl} differs from domain ${this.base}`;
      throw makeError('DOMAIN', msg);
    }
    const info = await this._lookupInfo(components);
    if (!info || !info.isActive) {
      throw makeError('NOT_FOUND',  `${shortUrl} not found`);
    }
    else {
      const update = { $set: { count: info.count + 1 } };
      await this.infos.updateOne({_id: info.shortUrl }, update);
      return { value: `${components.scheme}://${info.longUrl}` };
    }
  }


  /** The argument url must be one of a previously added (longUrl,
   *  shortUrl) pair.  It may be the case that url is currently
   *  deactivated.
   *
   *  If there are no errors, then return an object having the following
   *  properties:
   *
   *     longUrl:   the associated long url.
   *     shortUrl:  the associated long url.
   *     count:     a count of the total number of times
   *                shortUrl was successfully looked up using query().
   *     isActive:  a boolean denoting whether or not the mapping is active.
   *
   * Note that the info should be returned even if url is currently
   * deactivated.
   *
   * If an error occurs, then an exception is thrown. The following
   * error codes are defined for errors explicitly checked for:
   *
   *   'URL_SYNTAX': url syntax is incorrect (it does not contain
   *                 a :// substring, or the base is invalid).
   *
   *   'NOT_FOUND':  url was never registered for this service.
   */
  async info(url) {
    const components = splitUrl(url, /^https?$/i);
    if (components.error) throw makeError(components.error);
    const info = await this._lookupInfo(components);
    if (!info) {
      throw makeError('NOT_FOUND', `${url} not found`);
    }
    else {
      const ret = Object.assign({}, info);
      delete ret._id;
      return ret;
    }
  }


  /** The argument url must be one of a previously added (longUrl,
   *  shortUrl) pair.  It is not an error if the url has already
   *  been deactivated.
   *
   *  If there are no errors, then return an empty object and make the
   *  association between (longUrl, shortUrl) unavailable to
   *  future uses of the query() method.
   *
   * If an error occurs, then an exception is thrown. The following
   * error codes are defined for errors explicitly checked for:
   *
   *   'URL_SYNTAX':  url syntax is incorrect (it does not contain
   *                  a :// substring, or the base is invalid).
   *
   *   'NOT_FOUND':  url was never registered for this service.
   */
  async deactivate(url) {
    const components = splitUrl(url, /^https?$/i);
    if (components.error) throw makeError(components.error);
    const info = await this._lookupInfo(components);
    if (!info) {
      throw makeError('NOT_FOUND', `${url} not found`);
    }
    else if (info.isActive) {
      await this._setActiveStatus(info, false);
    }
    return {};
  }

  async _setActiveStatus(info, status) {
    const update = { $set: {isActive: status} };
    await this.infos.updateOne({_id: info.shortUrl}, update);
  }

  async _lookupInfo(components) {
    const key = `${components.base}${components.rest}`;
    let shortKey;
    if (components.base === this.base) {
      shortKey = key;
    }
    else {
      const shortLongMap = await this.urls.findOne({_id: key});
      if (!shortLongMap) return null;
      shortKey = shortLongMap.shortUrl;
    }
    return await this.infos.findOne({_id: shortKey});
  }


  /** Return shortening of base and rest of components */
  _shorten(components) {
    const { base, rest } = components;
    let shortKey;
    do { //while not previously created
      const shortened = Math.floor(MAX_RAND * Math.random()).toString(36);
      shortKey = `${this.base}/${shortened}`;
    } while (this.urls[shortKey]);
    return shortKey;
  }


}

module.exports = UrlShortener

const MAX_RAND = (2 ** 32);
const COLLECTIONS = {
  infos: 'infos',  //map shortUrl to info
  urls: 'urls',    //map longUrl to shortUrl
};
const MONGO_OPTIONS = {
  useNewUrlParser: true
};

function splitUrl(url, schemeRegex=null) {
  const m =  url.match(/(\w+):\/\/([^/]+)(.*)/);
  if (!m) return error('URL_SYNTAX', `bad URL ${url}`);
  const [_, scheme, base, rest] = m;
  const err = isBaseError(base);
  if (err) {
    return error('URL_SYNTAX', err);
  }
  else if (schemeRegex && !schemeRegex.test(scheme)) {
    return error('URL_SYNTAX', `invalid scheme "${scheme}"`);
  }
  else {
    return {
      scheme: scheme.toLowerCase(),
      base: base.toLowerCase(),
      rest
    };
  }
}

function error(code, msg) {
  return ({
    error: {
      code,
      message: msg,
    }
  });
}

function makeError(errOrCode, msg) {
  const {code, message} = msg ? { code: errOrCode, message: msg } : errOrCode;
  const err = new Error(message);
  err.code = code;
  return err;
}
