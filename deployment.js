#!/usr/bin/env node
// # The *Deployment* Server

// Load vendor modules
var express = require('express');
var path = require('path');
var fs = require('fs');

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
//	    console.log("VALUES " + val + " "+paths[path]+" -- "+val.search(paths[path]));
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
    affectedEntities = affectedEntities.filter(function(val,ind,arr){return (val != null && val!=arr[ind -1]) });

    return affectedEntities;
}

/*
Get dependency subGraph: Given a set of modified entities
we want to build a graph containing the information to execute
deployment.
*/
var getActionsToTake = function(dependency, entity){
    
    var type = modules[entity].dependencies.filter(function(val){return val.name==dependency})[0].type;
    var action = "";

    switch(type){
    case "hard":
	action = "restart";
	break;
    case "soft":
	break;
    default:
	action = "restart";
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
		"actions": ["install", "restart"]
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
	
	//Let's add its dependencies to pending array
	for(depIndex in modules[pendingNames[pendingIndex]].dependencies){
	    var dependency = modules[pendingNames[pendingIndex]].dependencies[depIndex];
	    pending.push(
		{
		    "name": dependency.name,
		    "level": modules[dependency.name].level,
		    "actions": getActionsToTake(dependency.name,pending[pendingIndex].name)
		});    
	    pendingNames.push(dependency.name);
	}
	
	pending.splice(pendingIndex,1);
	pendingNames.splice(pendingIndex,1);
	pendingIndex = pending.length-1;
    
    }

    result = result.sort(function(a,b){return a.level - b.level})
    return result;    
}

//Builds deployment execution flow
var getExecutionFlow = function(node){
    for(index in graph){
	node = graph[index];
	console.log("Module "+ node.name +" is in level "+ node.level + " and the actions to take are: "+ node.actions);
    }
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
		console.log("Execution flow found");
		getExecutionFlow(graph);
	    }catch(err){
		
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
console.log('Deployment server running on port "' + config.rpc.port);
