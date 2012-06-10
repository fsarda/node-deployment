#!/usr/bin/env node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');
var async = require('async');
var child = require('child_process');

// Load configuration files
var config = JSON.parse(fs.readFileSync(path.join(__dirname + "/config.json"), "utf8"));
var modules = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-modules.json"), "utf8"));
var servers = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-servers.json"), "utf8"));
var configDeployData = JSON.parse(fs.readFileSync(path.join(__dirname + "/deployment-config.json"), "utf8"));
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

//Verifies if the request comes from  github
var isRequestFromGitHubRepository = function(request, configData){
    return request.repository!=undefined && configData.repositoryName.toUpperCase() === request.repository.name.toUpperCase();
}


//Verifies conditions for running automated deployment
var isAuthorizedProductionChange = function(request, configData){
    
    //Check if is a production branch push
    var response = request.ref.indexOf(configData.productionBranch)!=-1;
    
    //Not everyone is authorized. Let's check if the pusher is
    if(configData.authorizedCommitUsers.length!=0){
	response = response && configData.authorizedCommitUsers.indexOf(request.pusher.name) != -1;
    }

    return response;

}

//Search the corresponding module for each entity changed
var getMappedEntity = function(val){
    
    //We are not interested in file names, only path to them
    var array = val.split("/");
    var rest =array.splice(0,array.length -1);
    val = rest.join("/");
    
    for(mod in modules){
	var paths = modules[mod].paths;
	for(path in paths){
	    if(val.search(paths[path])!= -1){
		return mod;
	    }
	}
    }
    
    return null;
};

//Get list of servers where modifications where made
var getModifiedEntities = function(request){
    
    var commitModules = [];

    //collect the changed paths
    for(commit in request.commits){
	var current = request.commits[commit];
	var added = current.added == undefined ? [] : current.added;
	var modified = current.modified== undefined ? [] :current.modified;
	var deleted = current.deleted== undefined ? [] :current.deleted;
	commitModules = commitModules.concat(added,modified,deleted);
    }
       
    //Getting affected entities
    affectedEntities = commitModules.map(getMappedEntity);
    affectedEntities = affectedEntities.sort();
    affectedEntities = affectedEntities.filter(function(val,ind,arr){return (val != null && val!=arr[ind -1]) });

    return affectedEntities;
}

/*
Get dependency subGraph: Given a set of modified entities
we want to build a graph containing the information to execute
deployment.
*/
var getActionsToTake = function(dependency, entity){

    var type = (entity==='none')?"initial":modules[entity].dependencies.filter(function(val){return val.name==dependency})[0].type;
    var action = "";
    var dependingEntity = modules[dependency];
    
    switch(type){
    case "hard":
	action = dependingEntity.type==="server"?["restart"]:["copy","install"];
	break;
    case "soft":
	break;
    case "initial":
	action = dependingEntity.type==="server"?["copy","install","restart"]:["copy","install"];
	break;
    default:
	action = dependingEntity.type==="server"?["restart"]:["copy","install"];
	break;
    }
    
    return action;
}


var getDependencySubGraph = function(entities){
    
    var result = [];
    var resultNames = [];
    var subgraph = [];
    var pending = [];
    var pendingNames = [];
    var pendingIndex = 0;
    
    //Initialize pending array with modified entities
    //This entities have to be reinstalled and restarted
    //In case of being dependencies of type library, configured 
    //restart action will be none so it will be only installed
    for(entityIndex in entities){
	if(pending.indexOf(entities[entityIndex])==-1){
	    var aux = {
		"name": entities[entityIndex],
		"level": modules[entities[entityIndex]].level,
		"actions": getActionsToTake(entities[entityIndex],'none')
	    }; 
	    pending.push(aux);
	    pendingNames.push(entities[entityIndex]);
	}
    }
    
    //Look for dependencies and respective actions to take
    pendingIndex = pending.length-1;
    while(pending.length != 0){
	
	//Let's put the entity in the result array
	if(resultNames.indexOf(pendingNames[pendingIndex])==-1){
	    result.push(pending[pendingIndex]);
	    resultNames.push(pendingNames[pendingIndex]);
	}
	
	//Let's add its dependencies to result array
	for(depIndex in modules[pendingNames[pendingIndex]].dependencies){
	    var dependency = modules[pendingNames[pendingIndex]].dependencies[depIndex];

	    if(resultNames.indexOf(dependency.name)==-1){		
		result.push(
		{
		    "name": dependency.name,
		    "level": modules[dependency.name].level,
		    "actions": getActionsToTake(dependency.name,pending[pendingIndex].name)
		});    
		resultNames.push(dependency.name);
	    }
	}
	
	pending.splice(pendingIndex,1);
	pendingNames.splice(pendingIndex,1);
	pendingIndex = pending.length-1;
    
    }
    
    result = result.sort(function(a,b){return a.level - b.level})
    return result;    
}

//Replace values in installations commands
var buildCommand = function(command,location){

    command = command.replace('%production.keypath%', configDeployData.prodKeyPath);
    command = command.replace('%production.keypath%', configDeployData.prodKeyPath);
    command = command.replace('%location%', location);
    return command;

}

var getEntityLocations = function(entity){
    
    switch(entity.type){
    case 'library':
	var locations = [];
	
	for(i in entity.dependencies){
	    locations = locations.concat(modules[entity.dependencies[i].name].location);
	}
	
	return locations.sort().filter(function(val,ind,arr){return (val != null && val!=arr[ind -1]) });
	break;
    default:
	return entity.location;
	break;

    }


}


//Builds deployment execution flow as a hash of intructions  
var getExecutionFlow = function(graph){
    
    var commands = {"copy":[],"install":[], "restart":[]};
    
    for(index in graph){
	node = graph[index];
	entity = modules[node.name];
	locations = getEntityLocations(entity);

	for(location in locations){
	    for(action in node.actions){
		commands[node.actions[action]].push(buildCommand(entity[node.actions[action]],locations[location]));
	    }
	}
    }
    
    return commands;
}


var print = function(error, stdout, stderr){
    //console.log(stdout);
    //console.log(error+" "+stderr);
    console.log("Callback called!!!");
}


var simpleExec = function(command){
    var n = child.exec(command, print);    
    console.log("Starting process "+JSON.stringify(n.pid)+" "+command);
    
}

var fork = function(command){

    var process = child.fork(__dirname+"/deploymentChild.js");

    process.on('message', function(message){
	console.log("Ending process ["+process.pid+"] "+command+" with code " + message.code);
	process.kill('SIGTERM');
	return true;
    });
    
    process.send({"command": command});
    
}


//Execue commands does the actual deployment
//by executing bash commnads
var executeCommands =  function(commands){
    
    var date = new Date();
    
    console.log("\n["+date+"] Pull changes " + configDeployData.updateRepoAction);
    child.exec(configDeployData.updateRepoAction, function(error, stdout, stderr){
	console.log(stdout);
	
	if(error != null){
	    console.log("Aborting process. Repository pull was not successfully executed");
	}else{
	    console.log("\n["+date+"] Executing install commands ");
	    async.parallel(commands["copy"].map(fork), function(){
		console.log("\n["+date+"] Executing restart commands ");
	    });   
	}

    })

    //pull changes
/*
    console.log("\n["+date+"] Pull changes " + configDeployData.updateRepoAction);
    async.series([simpleExec(configDeployData.updateRepoAction, print),
		  console.log("Starting install..."),
		  async.parallel(commands["copy"].map(simpleExec))]);
		  */

    //first execute copy commands
    /*async.series([commands["copy"].map(fork)],
		 function(err, results){
		     console.log("AAAAAAAAAAAAAA" + err + " " + results);
		     });
		     */
    
    //then install commands
/*    for(installIndex in commands["install"]){
	console.log("\n["+date+"] Executing install command: " + commands["install"][installIndex]);
    }

    //finally restart
    for(restartIndex in commands["restart"]){
	console.log("\n["+date+"] Executing restart command: " + commands["restart"][restartIndex]);
    }*/
}


//Setting up controller for GET on /
server.get('/', function(req, res){
    res.send("Gettint request "+ req.body);
});

//Setting up controller on '/deployment' url post

//This is server's main flow. In case of getting a valid
//request from a github's production push, builds a structure
//to make production enviroment deployment 
server.post('/deployment', express.bodyParser(), function(req, res) {
    
    var date = new Date();
    console.log("["+date+"] Arriving request "+JSON.stringify(req.body)+"\n");
    
    var request  = JSON.parse(req.body.payload);
    console.log("["+date+"] Parsing request "+JSON.stringify(request)+"\n");
    
    if(isRequestFromGitHubRepository(request, configDeployData)){
	console.log("["+date+"] This push is from github's " + configDeployData.repositoryName + " repository");

	if(isAuthorizedProductionChange(request, configDeployData)){	    
	    console.log("["+date+"] This is an authorized production branch push");
	    
	    servers = getModifiedEntities(request);
	    console.log("["+date+"] List of modified entities: " + servers);	    

	    graph = getDependencySubGraph(servers);
	    console.log("["+date+"] Dependency subgraph found: " + graph.map(JSON.stringify));	    
	    
	    try{
		commands = getExecutionFlow(graph);
		executeCommands(commands);
	    }catch(err){
		console.log("An error has occurred --->"+err);
	    }
	    
	    console.log("["+date+"] Proccessing...");
	    res.send("Proccessing...\n");
	    
	}else{
	    console.log("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(request));	    
	    res.send("["+date+"] This request does not correspond to an authorized production change " + JSON.stringify(request));	    
	}
	
    }else{
	console.log("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
	res.send("["+date+"] This request does not have git hub hook's format " + JSON.stringify(req.body));
    }
    
}, function(err, req, res, next) {
    console.log("An error has occurred processing the request..." + err);
    res.send("An error has occurred processing the request..." + err);
});

//Starting listener on configured port
server.listen(config.rpc.port);

/*
var print = function(callback, string){
    setTimeout(function(){
        callback(null, string);
    }, 200);
}
async.parallel([print(console.log,'hola1'),
		print(console.log,'hola2'),
		print(console.log,'hola3'),
		print(console.log,'hola4')], function(err, result){});
		*/

console.log('Deployment server running on port "' + config.rpc.port);
