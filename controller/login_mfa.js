'use strict';
var qr = require('qr-image');
var	merge = require('utils-merge'),
	TotpStrategy = require('passport-totp').Strategy,
	base32 = require('thirty-two'),
	capitalize = require('capitalize'),
	// User,
	passport,
	loginExtSettings,
	appSettings,
	appenvironment,
	mongoose,
	logger,
	CoreUtilities,
	CoreController,
	CoreMailer,
	Custom_User_Objects={};

/**
 * passport totp configuration
 * @param  {object} req
 * @param  {object} res
 * @return {Function} next() callback
 */
var totp_callback = function(req,res,next){
	let adminPostRoute = res.locals.adminPostRoute || 'auth';
	loginExtSettings.settings.authMFALoginPath = '/'+adminPostRoute+'/login-otp';
	var loginFailureUrl = (req.session.return_url) ? req.session.return_url : loginExtSettings.settings.authMFALoginPath + '?return_url=' + req.session.return_url;

	passport.authenticate('totp',{ 
		failureRedirect: loginFailureUrl, 
		failureFlash: 'Invalid MFA Token.' 
	})(req,res,next);
};

/**
 * set secondfact success to session and redirect to original url
 * @param  {object}   req  express request
 * @param  {object}   res  express reponse
 * @return {null}        does not return a value
 */
var totp_success = function(req,res){
	let adminPostRoute = res.locals.adminPostRoute || 'auth';

	var loginUrl = (req.session.return_url && req.session.return_url!=='/'+adminPostRoute+'/login-otp') ? req.session.return_url : loginExtSettings.settings.authLoggedInHomepage;
	req.session.secondFactor = 'totp';

	res.redirect(loginUrl);
};

/**
 * generates random key for MFA device token
 * @param  {number} len number of characters for key
 * @return {string}     generated key
 */
var randomKey = function(len) {
  var buf = [], 
  	chars = 'abcdefghijklmnopqrstuvwxyz0123456789', 
  	charlen = chars.length,
  	getRandomInt = function(min, max) {
		  return Math.floor(Math.random() * (max - min + 1)) + min;
		};

  for (var i = 0; i < len; ++i) {
    buf.push(chars[getRandomInt(0, charlen - 1)]);
  }

  return buf.join('');
};

/**
 * returns MFA device code generation data, the key, allow_new_code and the time periodic.
 * @param  {object}   user logged in user object
 * @param  {Function} fn   callback function
 * @return {Function}       async callback function
 */
var findKeyForUserId =  function(user, fn) {
	var mfa_data ={};
	if(user && user.extensionattributes && user.extensionattributes.login_mfa&& user.extensionattributes.login_mfa.key){
		mfa_data.key = user.extensionattributes.login_mfa.key;
		mfa_data.period = user.extensionattributes.login_mfa.period;
		mfa_data.allow_new_code = user.extensionattributes.login_mfa.allow_new_code;
	}
  return fn(null, mfa_data);
};

/**
 * saves token for MFA device
 * @param  {string}   userid  user mongo id
 * @param  {object}   keydata object that contains, key (MFA device key),period (TOTP timeout period) and allow_new_code (set to false)
 * @param  {Function} cb      callback function
 */
var saveKeyForUserId = function(userid, keydata, modelNameToUse, cb) {
	let UserModelToUse = Custom_User_Objects[modelNameToUse];
	UserModelToUse.findOne({
		'_id': userid
	}, function (err, user) {
		if (err) {
			logger.error('error finding the user for saving mfa token');
			cb(err, null);
		}
		else {
			user.markModified('extensionattributes');
			user.extensionattributes = user.extensionattributes || {};
			user.extensionattributes.login_mfa = keydata;
			user.extensionattributes.login_mfa.allow_new_code = false;

			user.save(function (err, usr) {
				if (err) {
					cb(err, null);
				}
				cb(null, usr);
			});
		}
	});
};

/**
 * generates token for manual entry and qr image for google authenticator TOTP, if a user needs to reset token, user.extensionattibutes.login_mfa.allow_new_code must be set to 'true'
 * @param  {object}   req  express request
 * @param  {object}   res  express reponse
 * @return {null}        does not return a value
 */
var mfa_setup_page = function(req,res){
	// console.log('req.user',req.user);
	if(!Custom_User_Objects[req.user.entitytype]){
		Custom_User_Objects[req.user.entitytype] = mongoose.model(capitalize(req.user.entitytype));
	}
	let adminPostRoute = res.locals.adminPostRoute || 'auth';
	var otpUrl,qrImage,encodedKey;
	findKeyForUserId(req.user, function(err, obj) {
    if (err) { 
			CoreController.handleDocumentQueryErrorResponse({
				err: err,
				res: res,
				req: req
			});
		}
   else if (obj && obj.key) {
   		if(obj.allow_new_code!==true){
   			var mfaError = new Error('User is not accessible to new mfa token setup, please contact your admin');
   			logger.error(mfaError);
   			CoreController.handleDocumentQueryErrorResponse({
					err: mfaError,
					res: res,
					req: req
				});
   		}
   		else{
      // two-factor auth has already been setup
      encodedKey = base32.encode(obj.key);
      
      // generate QR code for scanning into Google Authenticator
      // reference: https://code.google.com/p/google-authenticator/wiki/KeyUriFormat
      otpUrl = 'otpauth://totp/' + req.user.email + '?secret=' + encodedKey + '&period=' + (obj.period || 30)+'&issuer='+encodeURIComponent(appSettings.name);
var svg_string = qr.imageSync((otpUrl), { type: 'svg' });

      qrImage = 'https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=' + encodeURIComponent(otpUrl);
      
      var viewtemplate = {
					viewname: 'user/login-mfa-setup',
					themefileext: appSettings.templatefileextension,
					extname: 'periodicjs.ext.login_mfa'
				},
				viewdata = {
					pagedata: {
						title: 'Multi-Factor Authenticator Setup',
						toplink: '&raquo; Multi-Factor Authenticator Setup',
						extensions: CoreUtilities.getAdminMenu()
					},
					key: encodedKey, 
					qrImage: qrImage,
					svg_string: svg_string, 
					user: req.user,
					adminPostRoute: adminPostRoute
				};

			CoreController.renderView(req, res, viewtemplate, viewdata);
   		}
    } 
    else {
      // new two-factor setup.  generate and save a secret key
      var key = randomKey(10);
      encodedKey = base32.encode(key);
      
      // generate QR code for scanning into Google Authenticator
      // reference: https://code.google.com/p/google-authenticator/wiki/KeyUriFormat
      otpUrl = 'otpauth://totp/' + req.user.email + '?secret=' + encodedKey + '&period=30&issuer='+encodeURIComponent(appSettings.name);
var new_svg_string = qr.imageSync((otpUrl), { type: 'svg' });
      qrImage = 'https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=' + encodeURIComponent(otpUrl);
  
      saveKeyForUserId(req.user, { key: key, period: 30 }, req.user.entitytype, function(err) {
        if (err) { 
        	CoreController.handleDocumentQueryErrorResponse({
						err: err,
						res: res,
						req: req
					});
        }
        else{
	    		var viewtemplate = {
							viewname: 'user/login-mfa-setup',
							themefileext: appSettings.templatefileextension,
							extname: 'periodicjs.ext.login_mfa'
						},
						viewdata = {
							pagedata: {
								title: 'Multi-Factor Authenticator Setup',
								toplink: '&raquo; Multi-Factor Authenticator Setup',
								extensions: CoreUtilities.getAdminMenu()
							},
							key: encodedKey, 
							qrImage: qrImage, 
							svg_string: new_svg_string,
							user: req.user,
							adminPostRoute: adminPostRoute
						};

					CoreController.renderView(req, res, viewtemplate, viewdata);
        }
      });
    }
  });
};

/**
 * log into account with MFA token
 * @param  {object}   req  express request
 * @param  {object}   res  express reponse
 * @return {null}        does not return a value
 */
var mfa_login_page = function(req,res){
	let adminPostRoute = res.locals.adminPostRoute || 'auth';
  findKeyForUserId(req.user, function(err, obj) {
	// console.log('obj',obj);
    if (err) { 
    	CoreController.handleDocumentQueryErrorResponse({
				err: err,
				res: res,
				req: req
			});
    }
    else if (!obj || (obj && !obj.key)) { 
    	return res.redirect('/'+adminPostRoute+'/login-otp-setup'); 
    }
    else{
  		var viewtemplate = {
					viewname: 'user/login-mfa-otp',
					themefileext: appSettings.templatefileextension,
					extname: 'periodicjs.ext.login_mfa'
				},
				viewdata = {
					pagedata: {
						title: 'Multi-Factor Authenticator',
						toplink: '&raquo; Multi-Factor Authenticator',
						extensions: CoreUtilities.getAdminMenu()
					},
					user: req.user,
					adminPostRoute: adminPostRoute
				};

			CoreController.renderView(req, res, viewtemplate, viewdata);
    }
  });
};

/**
 * forces a user to login to previously requested url path
 * @param  {object}   req  express request
 * @param  {object}   res  express reponse
 * @param  {Function} next express next callback
 * @return {null}        does not return a value
 */
var forceAuthLogin = function (req, res) {
	if (req.originalUrl) {
		req.session.return_url = req.originalUrl;
		res.redirect(loginExtSettings.settings.authLoginPath + '?return_url=' + req.originalUrl);
	}
	else {
		res.redirect(loginExtSettings.settings.authLoginPath);
	}
};

/**
 * in order to configure MFA you need to skip MFA check on setup pages
 * @param  {object}   req  express request
 * @param  {object}   res  express reponse
 * @param  {Function} next express next callback
 * @return {null}        does not return a value
 */
var skip_mfa_check = function(req,res,next){
	req.controllerData = (req.controllerData) ? req.controllerData : {};
	req.controllerData.skip_mfa_check = true;
	next();
};

/**
 * make sure a user is authenticated, if not logged in, send them to login page and return them to original resource after login
 * @param  {object} req
 * @param  {object} res
 * @return {Function} next() callback
 */
var ensureAuthenticated = function (req, res, next) {
	let adminPostRoute = res.locals.adminPostRoute || 'auth';
	req.controllerData = (req.controllerData) ? req.controllerData : {};
	/* if a user is logged in, and requires to link account, update the user document with social credentials and then pass to the next express middleware */
	if (req.isAuthenticated()) {
		if (req.session.linkaccount === true) {
			var updateuser = {};
			updateuser.attributes = merge(req.user.attributes, req.session.linkaccountdata);
			CoreController.updateModel({
				cached: req.headers.periodicCache !== 'no-periodic-cache',
				model: User,
				id: req.user._id,
				updatedoc: updateuser,
				res: res,
				req: req,
				callback: function (err /* , updateduser */ ) {
					if (err) {
						next(err);
					}
					else {
						logger.verbose('linked ', req.session.linkaccountservice, ' account for ', req.user.id, req.user.email, req.user.username);
						req.session.linkaccount = false;
						delete req.session.linkaccount;
						delete req.session.linkaccountdata;
						delete req.session.linkaccountservice;
						next();
					}
				}
			});

			// next(new Error('cannot link '+req.session.linkaccountservice+' account'));
			// res.redirect('/user/linkaccount?service='+req.session.linkaccountservice);
		}
		else if (loginExtSettings && loginExtSettings.settings.disablesocialsignin === true && req.user.accounttype === 'social-sign-in' && req.query.required !== 'social-sign-in' && req.method === 'GET') {
			res.redirect('/'+adminPostRoute+'/user/finishregistration?reason=social-sign-in-pending');
		}
		else if (loginExtSettings && loginExtSettings.settings.requireusername !== false && !req.user.username && req.query.required !== 'username' && req.method === 'GET') {
			res.redirect('/'+adminPostRoute+'/user/finishregistration?required=username');
			// return next();
		}
		else if (loginExtSettings && loginExtSettings.settings.requireemail !== false && !req.user.email && req.query.required !== 'email' && req.method === 'GET') {
			res.redirect('/'+adminPostRoute+'/user/finishregistration?required=email');
		}
		else if (loginExtSettings && loginExtSettings.settings.requireemail !== false && !req.user.email && req.query.required !== 'email' && req.method === 'GET') {
			res.redirect('/'+adminPostRoute+'/user/finishregistration?required=email');
		}
		else if (loginExtSettings && loginExtSettings.settings.requireuseractivation && req.user.activated === false && req.query.required !== 'activation' && req.method === 'GET') {
			res.redirect('/'+adminPostRoute+'/user/finishregistration?required=activation');
		}
		else if(loginExtSettings && loginExtSettings.settings.requiremfa !== false && req.controllerData.skip_mfa_check!==true && req.method === 'GET'){
			if (req.session.secondFactor === 'totp') { 
				return next(); 
			}
			else{
				res.redirect('/'+adminPostRoute+'/login-otp');
			}
		}
		else {
			return next();
		}
	}
	else {
		if (req.query.format === 'json') {
			res.send({
				'result': 'error',
				'data': {
					error: 'authentication requires '
				}
			});
		}
		else {
			logger.verbose('controller - login/user.js - ' + req.originalUrl);
			forceAuthLogin(req, res);
		}
	}
};

var userEditor = function(req,res,next){
	var viewtemplate = {
			viewname: 'p-admin/loginmfa/index',
			themefileext: appSettings.templatefileextension,
			extname: 'periodicjs.ext.login_mfa'
		},
		viewdata = merge(req.controllerData, {
			pagedata: {
				title: 'Login MFA',
				toplink: '&raquo; Login MFA',
				extensions: CoreUtilities.getAdminMenu()
			},
			user: req.user
		});
	CoreController.renderView(req, res, viewtemplate, viewdata);
};

var set_mfa_status = function (req,res,next) {
	req.controllerData = req.controllerData || {};
	var controllerDataVariable = req.controllerData.login_mfa_user_variable || 'user';
	req.controllerData.checkuservalidation = loginExtSettings.new_user_validation;
	req.controllerData.checkuservalidation.useComplexity = loginExtSettings.complexitySettings.useComplexity;
	req.controllerData.checkuservalidation.complexity = loginExtSettings.complexitySettings.settings.weak;

	// req.body = req.controllerData.user;
	req.body.docid = req.controllerData[controllerDataVariable]._id;
	req.body.accounttype = req.controllerData[controllerDataVariable].accounttype;
	req.body.email = req.controllerData[controllerDataVariable].email;
	req.body.attributes = req.controllerData[controllerDataVariable].attributes;
	req.body.extensionattributes = req.controllerData[controllerDataVariable].extensionattributes ||{};
	if(req.params.set_mfa_status ==='enable_mfa'){
		req.body.extensionattributes.login_mfa.allow_new_code = true;
	}
	else if(req.params.set_mfa_status ==='disable_mfa'){
		req.body.extensionattributes.login_mfa.allow_new_code = false;
	}

	req.skippassword = true;
	req.saverevision = false;
	next();
};

/**
 * login mfa controller
 * @module loginMFAController
 * @{@link https://github.com/typesettin/periodic}
 * @author Yaw Joseph Etse
 * @copyright Copyright (c) 2015 Typesettin. All rights reserved.
 * @license MIT
 * @requires module:fs
 * @requires module:utils-merge
 * @requires module:qr-image
 * @requires module:thirty-two
 * @param  {object} resources variable injection from current periodic instance with references to the active logger and mongo session
 * @return {object}           updated passport, updated ensureAuthenticated
 */
var controller = function(resources){
	logger = resources.logger;
	mongoose = resources.mongoose;
	appSettings = resources.settings;
  CoreController = resources.core.controller;
  passport = resources.app.controller.extension.login.auth.passport;
  CoreUtilities = resources.core.utilities;
	// CoreExtension = resources.core.extension;
	loginExtSettings = resources.app.controller.extension.login.loginExtSettings;
	CoreMailer = resources.core.mailer;
	appenvironment = appSettings.application.environment;
	Custom_User_Objects = {
		'user' : mongoose.model('User')
	};
	// User = mongoose.model('User');


	passport.use(new TotpStrategy(
	  function(user, done) {
	    // setup function, supply key and period to done callback
	    findKeyForUserId(user, function(err, obj) {
	      if (err) { 
	      	return done(err); 
	      }
	      else{
		      return done(null, obj.key, obj.period);
	      }
	    });
	  }
	));


	return{
		passport: passport,
		totp_callback: totp_callback,
		totp_success: totp_success,
		skip_mfa_check: skip_mfa_check,
		mfa_login_page: mfa_login_page,
		mfa_setup_page: mfa_setup_page,
		userEditor: userEditor,
		set_mfa_status: set_mfa_status,
		ensureAuthenticated: ensureAuthenticated
	};
};

module.exports = controller;