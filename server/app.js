//var express = require('express');
//var app = module.exports = express.createServer();

var https = require('https');
const fs = require('fs');
var app = module.exports = https.createServer({
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem'),
    requestCert: false,
    rejectUnauthorized: false
});

var io = require('socket.io')(app);

io.on('connection', function(socket){
    io.sockets.emit("user-joined", socket.id, io.engine.clientsCount, Object.keys(io.sockets.clients().sockets));

    socket.on('signal', (toId, message) => {
	io.to(toId).emit('signal', socket.id, message);
    });

    socket.on('video-blob', (toId, buffer) => {
	io.to(toId).emit('video-blob', socket.id, buffer);
    });
    socket.on('audio-blob', (toId, buffer) => {
	io.to(toId).emit('audio-blob', socket.id, buffer);
    });

    socket.on("message", function(data) {
	io.sockets.emit("broadcast-message", socket.id, data);
    })

    socket.on('disconnect', function() {
	io.sockets.emit("user-left", socket.id);
    })
});

app.listen(3000, function() {
//    console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
    console.log("Server listening on port %d", app.address().port);
});
