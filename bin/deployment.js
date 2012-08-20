#!/usr/bin/env node
// Deployment module. Works installing 

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');
var child = require('child_process');
var aws = require('aws-lib');
var nodemailer = require('nodemailer');
var q = require('queue-flow');

// Load configuration files
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));
var deployConfig = JSON.parse(fs.readFileSync("deployment-config.json"), "utf8");
var server = express.createServer();

//global variables and constants
const diffCommand = "git diff --name-only %hash%";
const lastCommitCommand = "git log --pretty=format:'%H' -n 1";
const lastCommitInstalled = "lastHash.id";
const updateRepoCommand = deployConfig.updateRepoCommand;
const childFork = "deploymentChild.js";
const findAllCommand = "find . -name 'package.json'";
const configFile = "package.json";
var errors = [];
var depsName = [];

//Setting up server configuration
server.configure(function(){
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.methodOverride());
    server.use(server.router);
    
});

//Handles Error stage
q('error').each(function(value){
    console.log('Received error...');
    errors.push(value);
});


//Decides if signal received is an actionable sign (2)
q('signalVerification').filter(function(value){
    console.log('processing signal value');
    return validSignal(value);
    

}).chain('repoUpdate');


//Executes repo update (3)
q('repoUpdate').each(function(value){
    
    console.log('Received update signal...');
    
    //Execute updateRepo command
    fork(updateRepoCommand, function(err, result){

	if(err){
	    q('error').push(err);
	}else{
	    
	    //If everything is ok, we branch into two flows
	    //One to handle modified files and one to build
	    //internal packages structure
	    q('allPackages').push('signal');
	    q('changedFiles').push('signal');
	}
    })
});

//Flow to obtain modified files (4a)
q('changedFiles').each(function(value){
    
    //We search for last commit installed, if there is no last commit installed
    //we search for all config files from this directory
    var lastCommit = getLastCommit();	
    var command = lastCommit == null? findAllCommand : diffCommand.replace("%hash%",lastCommit);
    
    fork(command, function(err,message){
	if(err){
	    qf('error').push(err);
	}else{	
	    
	    var result = message.stdout.split("\n").sort()
		.filter(function(val,ind,arr){return (val != null && val.length!=0 && val!=arr[ind -1])});
	    q(result).chain('processChangedFiles');
	}
    });    
});


//Flow to get list of all packages files (4b)
q('allPackages').each(function(value){

    //Execute command to get list of all package.json files in repo
    fork(findAllCommand, function(err,message){
	if(err){
	    q('error').push(err);
	}else{	
	    
	    var result = message.stdout.split("\n").sort()
		.filter(function(val,ind,arr){return (val != null && val.length!=0 && val!=arr[ind -1])});
	    q(result).chain('processAllPackages');
	}
    });    
   
});

//(5a)
//Find closest package.json file attached to every file
//and flag package to restart if necessary
q('processChangedFiles')
    .map(
	//entity defines the path where we are going to look for (entity[0])
	//and a initQueue (entity[1]) for each entity. This initQueue is just 
	//the queue where this entity will start processing (copy or restart)
	function(path){

	    var array = path.split("/");
     	    array = array.splice(0,array.length-1);
     	    var path = array.length<=1?configFile:array.join("/")+"/"+configFile;
	    return path.replace("./","");

	})

//Let's test if path we build is correct. If we find the config file, our work is done
//but if we don't find it, we have to remove one directory from path and retry
    .exec(
	function(path){
	    var aux = fs.readFileSync(path, "utf8"); //FIX THIS!!!!
	    return JSON.parse(aux);
	})

//If we found config file and read it succesfully, now we can
//fully build entity with its config info
    .map(
	 function(entity){
	     var aux = {"name": entity[0].name, 
			"deps": entity[0].serviceDependencies, 
			"service": entity[0].service, 
			"path": entity[1].replace("./",""),
			"initQueue": entity[2]};


	     //Add to graph array and to auxiliar depsName array
	     //which will help in processing stage
	     depsName.push(aux.name);
	     return aux;
	 })


//(5b)
//Build internal data structure with package.json file
//information
q('processAllPackages').map(function(value){
    console.log("PAP " + value);
});

/*
q('dependenciesMarked')
q('linearize')
q('finalizeDeploy')
*/

///////////////////////////////////////////////////////
//Utility functions
//////////////////////////////////////////////////////

//Get last commit installed from file. If file
//does not exist, it will install everything
var getLastCommit = function(){
    
    var date = new Date();
    
    try{
	//read file containing last commit installed
	var lastCommit = JSON.parse(fs.readFileSync(path.join(lastCommitInstalled), "utf8")).commit;
	console.log("["+date+"] Last commit installed: " + lastCommit);
	return lastCommit;
    }catch(error){
	console.log("["+date+"] Error getting file " + lastCommitInstalled +". Installing all services.");
	return null;
    }
}

//Execute a bash command with a fork
var fork = function(command, callback){
    var date = new Date();
    var execOptions = {timeout: config.execInfo.timeout, killSignal: 'SIGTERM', env: {"PATH": config.execInfo.userPATH}};
    
    if(command.length != 0){

	//Execute a child process with command provided
	var process = child.fork(__dirname+"/"+childFork);    
	process.on('message', function(message){

	    //If there was an error
	    if(message.code != null){
		console.log("\n["+date+"] Received error  with code " + JSON.stringify(message));
		callback(message.code);
		return;
	    }


	    //If everything went well, end process and return
	    //console.log("\n["+date+"] Ending process ["+process.pid+"] "+command+" with code " + JSON.stringify(message));
	    process.kill('SIGTERM');
	    callback(null, message);
	    return message;

	});

	process.on("SIGTERM", function() {
	    process.exit();
	});    

	//Send exec arguments to child process
	process.send({"command": command, "options": execOptions, "retryCount": config.execInfo.retryCount});

    }else{
	callback(null, {"code":null, "stdout": "", "stderr": "" });
    }    	
}


var validSignal = function(signal){

    if(signal == null){
	return true;
    }

    var request  = JSON.parse(signal);
    return isAuthorizedProductionChange(request);
}

//Verifies conditions for running automated deployment
var isAuthorizedProductionChange = function(request){
    
    //Check if is a production branch push
    var response = request.ref.indexOf(deployConfig.repoInfo.branch)!=-1;
    
    //Not everyone is authorized. Let's check if the pusher is
    if(deployConfig.repoInfo.authorizedCommitUsers.length!=0){
	response = response && deployConfig.repoInfo.authorizedCommitUsers.indexOf(request.pusher.name) != -1;
    }
    
    return response;
    
}

//////////////////////////////////////////////////////////////////
//Controller for http requests
//////////////////////////////////////////////////////////////////

//Setting up controller for GET on /
server.get('/', function(req, res){
    res.send("Gettint request "+ req.body);
});


//Setting up controller for POST on /message
server.post('/message' ,express.bodyParser(),function(request, response){
    
    var date = new Date();
    console.log("["+date+"] Arriving message "+JSON.stringify(request.body));
    
    if(request.body.messageType = "restart"){
	index = pendingServiceInit.indexOf(request.body.entityName);
	if(index!=-1){
	    pendingServiceInit.splice(index, 1);
	}
    }
    
    console.log("["+date+"] Pending servers for restart: "+pendingServiceInit);
    
    //Process message
    response.send("Got message request from "+request.body.entityName);
}, function(err, request, response, next) { 
    console.error("An error has occurred processing the message..." + err);
    response.send("An error has occurred processing the message..." + err);
});


//Setting up controller on '/deployment' url post

//In case of getting a valid request from a github's 
//production push, builds a structure to make 
//production enviroment deployment 
server.post('/deployment', express.bodyParser(), function(req, res) {

    q('signalVerification').push(req.body);

}, function(err, req, res, next) {
    console.error("An error has occurred processing the request..." + err);
    res.send("An error has occurred processing the request..." + err);
});

//Starting listener on configured port
server.listen(config.rpc.port);
console.log('Deployment service running on port "' + config.rpc.port);

//Execute deployment process
q('signalVerification').push(null);