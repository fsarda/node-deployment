#!/usr/bin/env node
// Deployment module. Works installing 

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');
var child = require('child_process');
var aws = require('aws-lib');
var nodemailer = require('nodemailer');
var qf = require('queue-flow');

// Load configuration files
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));
var deploymentConfig = JSON.parse(fs.readFileSync("deployment-config.json"), "utf8");
var server = express.createServer();

//global variables and constants
const diffCommand = "git diff --name-only %hash%";
const lastCommitCommand = "git log --pretty=format:'%H' -n 1";
const lastCommitInstalled = "lastHash.id";
const updateRepoCommand = "git pull";
const childFork = "deploymentChild.js";
const findAllCommand = "find . -name 'package.json'";
const configFile = "package.json";
var installPaths = {};
var restartPaths = {};
var processed = {};
var graph = [];
var depsName = [];
var pendingServiceInit = []; 

//Setting up server configuration
server.configure(function(){
    server.use(express.favicon());
    server.use(express.logger('dev'));
    server.use(express.methodOverride());
    server.use(server.router);
    
});

//Send report email when everything has finished running
var sendReportEmail = function(message,  entities, instructions, commit, callback){

    var textBody ="A deployment process has been executed with the following characteristics: \n"+
	"Commit id: " + lastCommitInstalled()+"\n"+
	"Modified entities: " + entities+"\n\n";

    if(instructions.length!=0){
	textBody += "Instructions to execute: \n\n";
	
	for(i in instructions){
	    textBody += i+" instructions:\n";
	    for(j in instructions[i]){
		textBody += "- "+instructions[i][j]+"\n";
	    }
	}
	
    }
    
    textBody += "\n\nReport Message: " +message+"\n";
    textBody += "\n\nError message: " +errors+"\n";
    textBody += "\n\nServers not restarted: " +pendingServiceInit+"\n";
    

    var htmlBody ="A deployment process has been executed with the following characteristics: <br/> "+
	"<span style='font-weight: bold; text-decoration: underline;'>Commit id:</span> <a href='#'>" + commit+"</a><br/>"+
	"<span style='font-weight: bold; text-decoration: underline;'>Modified entities:</span>" + entities+"<br/><br/>";

    if(instructions.length!=0){
	htmlBody += "<span style='font-weight: bold; text-decoration: underline;'>Instructions to execute:</span><br/><br/>";
	
	for(i in instructions){
	    htmlBody += "<span style='text-decoration: underline;'>"+i+" instructions:</span><br/>";
	    for(j in instructions[i]){
		htmlBody += "- "+instructions[i][j]+"<br/>";
	    }
	}
    }
    
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Report Message:</span>" +message+"<br/>";
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Error message:</span>" +errors+"<br/>";
    htmlBody += "<br/><span style='font-weight: bold; text-decoration: underline;'>Servers not restarted:</span> " +pendingServiceInit+"<br/>";
    
    
    var sendArgs = {
	'Destination.ToAddresses.member.1': deploymentConfig.deployEmail[0],
	'ReplyToAddresses.member.1': deploymentConfig.deployEmail[1],
	'Message.Body.Text.Charset': 'UTF-8',
	'Message.Body.Text.Data': textBody,
	'Message.Body.Html.Charset': 'UTF-8',
	'Message.Body.Html.Data': htmlBody,
	'Message.Subject.Charset': 'UTF-8',
	'Message.Subject.Data': 'Automatic deployment executed',
	'Source': deploymentConfig.sourceEmail
    };
    
    //send email HERE

    return callback({success: true});
};

//Initialize global values after deployment process has finished
var initValues = function(){
    pendingServerInit = [];
}

//This function makes deployment server wait a little
//for servers to restart
var waitRestarts = function(callback){

    var date = new Date();
    console.log("\n["+date+"] Waiting for servers to restart with a "+config.execInfo.restartTimeout+" milliseconds timeout"); 
    setTimeout(
	function(){
	    console.log("\n["+date+"] Already waited for servers. Pending for restart are: "+pendingServiceInit); 
	    callback();
	}	,config.execInfo.restartTimeout);	    
}


//Update file that contains last commit installed
var updateLastInstalled = function(callback){
    
    var date = new Date();
    
    //Get last hash from git log
    var commitJSON = fork(buildCommand(lastCommitCommand), function(err,message){
	
	//Write to file
	fs.writeFile(lastCommitInstalled, '{"commit":"'+message.stdout+'"}', function (err) {
	    if(err){
		console.log("["+date+"] An error has occurred writing file "+lastCommitInstalled);
		callback(err);
		return;
	    };
	    callback(null);
	    console.log("["+date+"] Last commit successfully saved: "+message.stdout);
	});
    });
} 

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


//Verifies if the request comes from  github
var isRequestFromGitHubRepository = function(request, configData){
    return request.repository!=undefined && 
	configData.repoInfo.repositoryName.toUpperCase() === request.repository.name.toUpperCase();
}

//Verifies conditions for running automated deployment
var isAuthorizedProductionChange = function(request, configData){
    
    //Check if is a production branch push
    var response = request.ref.indexOf(configData.repoInfo.productionBranch)!=-1;
    
    //Not everyone is authorized. Let's check if the pusher is
    if(configData.repoInfo.authorizedCommitUsers.length!=0){
	response = response && configData.repoInfo.authorizedCommitUsers.indexOf(request.pusher.name) != -1;
    }
    
    return response;
    
}

//Replace possibly configuration values in command to execute
var buildCommand = function(instruction,command,location, path){

    instruction = instruction.replace('%production.keypath%', deploymentConfig.prodKeyPath);
    instruction = instruction.replace('%development.keypath%', deploymentConfig.devKeyPath);
    instruction = instruction.replace('%command%', command);
    instruction = instruction.replace('%location%', location);
    instruction = instruction.replace('%user%', deploymentConfig.remoteUser);
    instruction = instruction.replace('%path%', path);
    return instruction;

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


//Get entities location list configured in files
var getEntityLocations = function(entity, graph){    
    
    
    if(entity.service == undefined){
	return [];
    }

    //If we are dealing with an entity of type library,
    //its locations are derived from the other entities that 
    //depend on it, so we have to look for locations of those entities
    switch(entity.service.type){
    case 'library':
	var locations = [];

	for(i in graph){
	    if(graph[i].deps != undefined){
		var j = 0;
		//for(j in graph[i].deps){ //This failed and i don't have a clue why
		while(j<graph[i].deps.length){
		    if(graph[i].deps[j].name == entity.name){
			locations = locations.concat(getEntityLocations(graph[i],graph));
		    }
		    j++;
		}
	    }
	}

	return locations.sort().filter(function(val,ind,arr){return (val != null && val!=arr[ind -1]) });
	break;
    default:

	//Otherwise we return locations configured for entity
	return entity.service.location;
	break;

    }
}


/*
  This queue receives a signal to trigger update repo command
*/
qf('updateRepo').exec(
    function(val, next){

	console.log("Receiving signal");

	//Execute updateRepo command
	fork(updateRepoCommand, function(err, result){
	    console.log("ended updating repo " + JSON.stringify(err) +" --- "+JSON.stringify(result));

	    if(!err){ //MUST BE if(err) but i have it for testing purposes
		qf('error').push(err);
		next([err, new Error('error updating repository')]);
	    }else{

		//If everything is ok, we send a signal to modifiedEntities
		//to determine which entities were modified in this version
		qf('modifiedEntities').push("modifiedEntitiesSignal");
		next();
	    }
	})
    });


/*
  This queue receives a signal from updateRepo queue, 
  triggering a diff command to list modified entities
*/
qf('modifiedEntities').exec(
    function(val,next){
	
	//We search for last commit installed, if there is no last commit installed
	//we search for all config files from this directory
	var lastCommit = getLastCommit();	
	var command = lastCommit == null? findAllCommand : diffCommand.replace("%hash%",lastCommit);
	
	fork(command, function(err,message){
	    if(err){
		qf('error').push(err);
		next([err, new Error('error calculating modified entities')]);
	    }else{	
		
		//If everything is ok, we send an array of distinct modified entities to 'installEntities'
		next(null, [message.stdout.split("\n").sort()
			    .filter(function(val,ind,arr){return (val != null && val.length!=0 && val!=arr[ind -1])})]); 
	    }
	});    
    }
).chain('installEntities');

/*
  In 'installEntities', is triggered process for each path and also 
  dependencies that need to be restarted are calculated
*/

//HERE I WANTED TO DO AN FOREACH BUT I 
//CAN'T GET TO TREAT IT AS AN ARRAY
qf('installEntities').exec(
    function(paths){
	paths.forEach(
	    function(path){
		if(!installPaths[path]){

		    //We look for config info of this entity
		    qf('entityInfo').push([path,'copy']);

		    //Let's put this entity in a hash to not re-process it
		    installPaths[path.replace("./","")] = true;
		}
	    })
    });


/* Queue 'dependencies' calculate dependencies for each
   entity received and passes to 'entityInfo' queue.
   Entities calculated in this queue are sent to 'restart'
   queue from 'entityInfo'
*/
qf('dependencies').exec(
    function(entity){	

	//If an path comes here, we are interested in its dependencies list
	//For each dependency we want to add it to the graph we are working 
	//with, so we send it to 'entityInfo' if has not been processed previously
	if(entity.deps){
	    entity.deps.map(
		function(path){
		    //If this entity has not been processed
		    if(!installPaths[path.path] && !restartPaths[path.path]){
			restartPaths[path.path.replace("./","")] = true;

			//We look for config info of this entity
			qf('entityInfo').push([path.path,'restart']);
		    }
		});
	}
    });



/*
  'entityInfo' calculates necessary info to process entity.
  Every object pushed to this queue is a pair [entity, [queueArray]]
  where entity is the path to be processed and queue is 
  destination queue of this entity.
  Builds an object from the configuration values saved in 
  every entity's package.json file and pushes that entity 
  into passed queue
*/

//We know which files have been modified but we don't know where 
//their corresponding configuration file is (so, we have to look 
//for it). To do that, we search backward in each path until we match 
// a directory containing config file
qf('entityInfo')

//Transform path received to a possible path of config file
    .map(
	//entity defines the path where we are going to look for (entity[0])
	//and a initQueue (entity[1]) for each entity. This initQueue is just 
	//the queue where this entity will start processing (copy or restart)
	function(entity){
	    
	    var array = entity[0].split("/");
     	    array = array.splice(0,array.length-1);
     	    var path = array.length<=1?configFile:array.join("/")+"/"+configFile;
	    return [path.replace("./",""), entity[1]];
	    
	})

//Let's test if path we build is correct. If we find the config file, our work is done
//but if we don't find it, we have to remove one directory from path and retry
    .exec(
	function(path, initQueue){
	    
	    try{
		var aux = JSON.parse(fs.readFileSync(path, "utf8"));
		return [null, [aux, path, initQueue]];
		//everything went ok 

	    }catch(err){		 
		//If we did not find file
		if(err.code == "ENOENT"){
		    
		    //Remove las directory from path
		    array = path.split("/");
		    array = array.splice(0,array.length-2);
		    path = array.length<=1?configFile:array.join("/")+"/"+configFile;
		    
		    //Resend to this queue to process it again
		    if(array.length>1){
			qf('entityInfo').push(path.replace("./",""));
		    } 

		//Something else occurred
		}else{
		    console.error("Unknown error processing path " + path + ": "+JSON.stringify(err));
		    return err;
		}
	    }
	},"error")

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
	     graph.push(aux);
	     depsName.push(aux.name);
	     

	     //If we have to reinstall this entity, search for its dependencies
	     if(entity[2] == 'copy'){
		 qf('dependencies').push(aux);
	     }
	     
	     return aux;
	 })
    .chain('process')

/*
  Queue 'process' manages the deploy process. Once we have all the information
  about dependencies to be installed and restarted, 'process' queue works with 
  each entity with order induced by dependency graph
*/
qf('process')
// Any item with no dependencies left is put into the process queue
// and flagged as processed
    .filter(function(item) {

	if(item.deps == undefined || item.deps.length == 0){
	    qf(item.initQueue).push(item);
	    processed[item.name] = true;
	    return false;
	}
	return true;
    })
// Otherwise, it is checked for dependencies that can be removed
    .map(function(item) {	
	if(item.deps != undefined){
	    item.deps = item.deps.filter(function(dep){

		//We filter those dependencies that have been processed or are not present in graph
		return processed[dep.name] !== true && depsName.indexOf(dep.name)!=-1;
		
	    });
	}
	
	return item;
	
    })
// And then puts it back into the 'process'  queue
    .chain('process');


/*
  Handles copy action for entities
*/
qf('copy').exec(
    function(entity,next){
	
	//NOT WORKING AT ALL
	var locations = getEntityLocations(entity, graph);
	var inst = entity.service.copy;
	var commands = locations.map(function(item){return buildCommand(inst,"",item,process.cwd()+"/"+entity.path)});
	
	console.log("COPY "+entity.name+"---"+JSON.stringify(locations));
	return next([null,entity]);
	
    }).chain('install');

/*
  Handles install action for entities
*/
qf('install').exec(
    function(entity){
	console.log("INSTALL "+JSON.stringify(entity));
	return [null,entity];
    }).chain('restart');


/*
  Handles restart action for entities
*/
qf('restart').exec(
    function(entity){
	console.log("RESTART "+JSON.stringify(entity));
    });



/*
  Error handler queue
*/
qf('error').each(
    function(val){
	console.log("Received error "+ JSON.stringify(val));
    }
);

/*
  Waits for restarts signal from each entity
*/
qf('waitRestarts').exec(waitRestarts.bind(this)).chain('finalizeDeployment');


/*
  End deployment process
*/
qf('finalizeDeployment').exec(
    //Send report email
    //Update Last Installed
    //init global variables
)


//Setting up controller for GETon /
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
    
    var date = new Date();
    var request  = JSON.parse(req.body.payload);
    console.log("["+date+"] Parsing request "+JSON.stringify(request)+"\n");
    
    if(isRequestFromGitHubRepository(request, config)){
	console.log("["+date+"] This push is from github's " + deploymentConfig.repoInfo.repositoryName + " repository");
	
	if(isAuthorizedProductionChange(request, config)){	    
	    console.log("["+date+"] This is an authorized production branch push");
	    
	    q('updateRepo').push("updateSignal");
	    
	    console.log("["+date+"] Proccessing...");
	    res.send("Proccessing...\n");
	    
	}else{
	    console.error("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(request.pusher)+"-"+JSON.stringify(request.ref));	    
	    res.send("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(request.pusher)+"-"+JSON.stringify(request.ref));	    
	}
	
    }else{
	console.error("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
	res.send("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
    }
    
}, function(err, req, res, next) {
    console.error("An error has occurred processing the request..." + err);
    res.send("An error has occurred processing the request..." + err);
});

//Starting listener on configured port
server.listen(config.rpc.port);
console.log('Deployment service running on port "' + config.rpc.port);

//Execute deployment process
qf('updateRepo').push("updateSignal");