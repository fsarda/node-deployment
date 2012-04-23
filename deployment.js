#!/usr/bin/env node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');

// Load the configuration file
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));

var server = express.createServer();

//Setting up server configuration
server.configure(function(){
    server.set('views', __dirname + '/views');
    server.set('view engine', 'html');
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.static(__dirname + '/public'));
    server.use(express.methodOverride());
    server.use(server.router);

});

//Rendering index.html on '/' url get
server.get('/', function(req, res){
    res.sendfile(__dirname + '/views/index.html');
});

//Setting up action on '/sayhello' url post
server.post('/sayhello', express.bodyParser(), function(req, res) {

    if(req.body.ref.indexOf("production")!= -1){
	res.send("Proccessing...");
    }else{
	res.send("Hello World!!! :D");
    }
    
}, function(err, req, res, next) {
    res.send("Good Bye World :(");
});

//Starting listener on configured port and host
server.listen(config.rpc.port,config.rpc.host);
console.log('Deployment server running on port "' + config.rpc.port);
