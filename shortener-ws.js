const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const Shortener = require('./url-shortener');

const OK = 200;
const CREATED = 201;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const CONFLICT = 409;
const SERVER_ERROR = 500;

function serve(port, base, model) {
  const app = express();
  app.locals.port = port;
  app.locals.base = base;
  app.locals.model = model;
  setupRoutes(app);
  app.listen(port, function() {
    console.log(`listening on port ${port}`);
  });
}

module.exports = {
  serve: serve
}

function setupRoutes(app) {
  const base = app.locals.base;
  app.use(cors());
  app.use(bodyParser.json());

  app.post('/x-url', add_url(app));
  app.delete('/x-url', deactivate_url(app));
  app.get('/x-url', get_info(app));
  app.get(/\/[a-z0-9]+/, load_url(app));
  app.post('/x-text', update_file(app));

  //routes for specific urls:
  //@TODO: set up routes for specific urls

  //error route
  app.use(doErrors()); //must be last
}

function load_url(app)
{
	return errorWrap(async function(req, res)
	{
		try
		{
			const result = await app.locals.model.query(requestUrl(req));
			res.redirect(result.value);
		}
		catch(err)
		{
      res.status(NOT_FOUND);
			res.json({status: NOT_FOUND, code: err.code, message: err.message});
		}
	});
}

function add_url(app)
{
	return errorWrap(async function(req, res)
	{
		try
		{
			const result = await app.locals.model.add(req.query.url);
      res.status(CREATED);
      res.json({value: result.value});
		}
		catch(err)
		{
      res.status(BAD_REQUEST);
			res.json({status: BAD_REQUEST, code: err.code, message: err.message});
		}
	});
}

function deactivate_url(app)
{
	return errorWrap(async function(req, res)
	{
		try
		{
			const result = await app.locals.model.deactivate(req.query.url);
			res.sendStatus(OK);
		}
		catch(err)
		{
      res.status(NOT_FOUND);
			res.json({status: NOT_FOUND, code: err.code, message: err.message});
		}
	});
}

function get_info(app)
{
	return errorWrap(async function(req, res)
	{
		try
		{
			const result = await app.locals.model.info(req.query.url);
			res.json(result);
		}
		catch(err)
		{
      res.status(NOT_FOUND);
			res.json({status: NOT_FOUND, code: err.code, message: err.message});
		}
	});
}

function update_file(app)
{
  var urls_info = {};
  return errorWrap(async function(req, res)
  {
    var new_text=req.body.text;;
    try
    {
      var regex=/https?:\/\/[a-z0-9]+([\_\-\/\.\?\=\&\%\#\@\+]{1}[a-z0-9]+)*/gi;
      var matches;
      while((matches = regex.exec(new_text)) !== null)
      {
        const result=await app.locals.model.add(matches[0]);
        new_text=new_text.replace(matches[0],result.value);
      }
    }
    catch(err)
    {}
  res.status(CREATED);
  res.json(new_text);
});
}


//@TODO add handlers for routes set up above.  Typical handler
//will be wrapped using errorWrap() to ensure that errors
//don't slip past the seams of any try-catch blocks within the
//handlers.  So a typical handler may look like:
//function doSomething(app) {
//  return errorWrap(async function(req, res) {
//    //do something typically within a try-catch
//   });
//}

/** Ensures a server error results in nice JSON sent back to client
 *  with details logged on console.
 */
function doErrors(app) {
  return async function(err, req, res, next) {
    res.status(SERVER_ERROR);
    res.json({ code: 'SERVER_ERROR', message: err.message });
    console.error(err);
  };
}

/** Set up error handling for handler by wrapping it in a
 *  try-catch with chaining to error handler on error.
 */
function errorWrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    }
    catch (err) {
      next(err);
    }
  };
}

/*************************** Mapping Errors ****************************/

const ERROR_MAP = {
  EXISTS: CONFLICT,
  NOT_FOUND: NOT_FOUND
}

/** Map domain/internal errors into suitable HTTP errors.  Return'd
 *  object will have a "status" property corresponding to HTTP status
 *  code.
 */
function mapError(err) {
  console.error(err);
  return err.code
    ? { status: (ERROR_MAP[err.code] || BAD_REQUEST),
	code: err.code,
	message: err.message
      }
    : { status: SERVER_ERROR,
	code: 'INTERNAL',
	message: err.toString()
      };
}

/****************************** Utilities ******************************/

/** Return original URL for req */
function requestUrl(req) {
  const port = req.app.locals.port;
  return `${req.protocol}://${req.hostname}:${port}${req.originalUrl}`;
}
