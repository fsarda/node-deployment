var childl = require('child_process');

process.on('message', function(m) {
    console.log("Executing child process with command " + m.command)
    childl.exec(m.command , sendToParent);
});


function sendToParent(error, stdout, stderr){
    if (error !== null) {
	process.send({ code: 1 });
    }else{
	process.send({ code: 0 });
    }
    
}
