const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const ejs = require('ejs');
const fs = require('fs');
const {v4: uuidv4} = require('uuid');
const bodyParser = require('body-parser');
const res = require('express/lib/response');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({extended: true}));
app.use(express.json());
app.use(express.static('public'));
app.set("view engine", "ejs");

const server = http.createServer(app);
const io = socketio(server);

const room = {};

function getRandomWordFromCSV(filePath) {
    return new Promise((resolve, reject) => {
        const words = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => words.push(data.word))
            .on('end', () => {
                if(words.length === 0){
                    return reject(new Error("No words found in CSV file"));
                }
                const randomIndex = Math.floor(Math.random() * words.length);
                resolve(words[randomIndex]);
            })
            .on('error', (error) => reject(error));
    });
}

app.get("/", (req, res) => {
    res.render("index");
});

app.post("/create-room", (req, res) => {
    const roomID = uuidv4().slice(0,6);
    const password = req.body.password;
    const username = req.body.username;
    const userID = uuidv4();
    
    room[roomID] = {password, occupants: 0, users: {[userID]: username}};

    res.redirect(`/game/${roomID}?username=${username}&userID=${userID}&password=${password}`);
});

app.post("/join-room", (req, res) => {
    const roomID = req.body.roomID;
    const password = req.body.password;
    const username = req.body.username;

    if(room[roomID]) {
        if(room[roomID].password === password) {
            const userID = uuidv4();
            //ユーザー名が被っているかどうかを確認
            if(Object.values(room[roomID].users).includes(username)){
                res.render('joined', {message: "Username already taken", roomID: null, password: null});
                return;
            }
            room[roomID].users[userID] = username;
            res.redirect(`/game/${roomID}?username=${username}&userID=${userID}&password=${password}`);
        } else {
            //res.json({status: "Password is incorrect"});
            res.render('joined', {message: "Password is incorrect", roomID: null, password: null});
        }
    } else {
        //res.status(404).json({status: "Room not found"});
        res.render('joined', {message: "Room not found", roomID: null, password: null});
    }
});

app.get("/game/:roomID", (req, res) => {
    const {roomID} = req.params;
    const username = req.query.username;
    const userID = req.query.userID;
    const room1 = room[roomID];

    if(room1) {
        if(req.query.password){
            if(req.query.password === room1.password){
                res.render("game", {roomID, username, userID});
            }else{
                res.render("password", {roomID, message: "Incorrect password."});
            }
        } else if (room1.passwowrd){
            res.render("password", {roomID, message: ""});
        } else {
            res.render("game", {roomID, username, userID});
        }
    } else {
        res.status(404).send("Room not found");
    }
});

app.post("/verify-password/:roomID", (req, res) => {
    const {roomID} = req.params;
    const {password, username} = req.body;
    const userID = uuidv4();

    if(room[roomID] && room[roomID].password === password){
        room[roomID].users[userID] = username;
        res.redirect("/game/${roomID}?username=${username}&userID=${userID}&password=${password}");
    } else {
        res.render("password", {roomID, message: "Incorrect password."});
    }
});

io.on("connection", (socket) => {
    let timerInterval;
    console.log("A user connected");

    socket.on("join-room", (data) => {
        const {roomID, userID, username} = data;
        const room1 = room[roomID];
        console.log(room);
        if(room1.occupants === null || room1.occupants === undefined || room1.occupants === NaN){
            room1.occupants = 0;
        }
        if(room1){
            room1.occupants += 1;
            room1.users[userID] = username;
            socket.join(roomID);
            io.to(roomID).emit("occupants", {occupants: room1.occupants, users: room1.users});
        }
    });

    socket.on("start-game", async (roomID) => {
        const room1 = room[roomID];
        if(!room1){
            return;
        }
        //room1.occupantsの数までのランダムな数字を生成
        keys = Object.keys(room1.users);
        for(let i = keys.length - 1; i > 0; i--){
            const j = Math.floor(Math.random() * (i + 1));
            [keys[i], keys[j]] = [keys[j], keys[i]];
        }
        //keyをシャッフルしたので、1番目と2番目のプレイヤーをそれぞれゲームマスターとインサイダーにする。
        const gameMaster = keys[0];
        const insider = keys[1];

        //ゲームマスターとインサイダーとランダムに選択した単語をクライアントに送信
        const csvFilePath = path.join(__dirname, "words.csv");
        try {
            const word = await getRandomWordFromCSV(csvFilePath);
            io.to(roomID).emit("game-started", {gamemaster: gameMaster, insider: insider, occupants: room1.users, target: word});
        } catch (error) {
            console.error(error);
            io.to(roomID).emit("game-error", {error: "Failed to start game"});
        }
    });


    socket.on("start-timer", (data) => {
        start = data.start;
        startTime = Date.now();
        timerInterval = setInterval(() => {
            const currentTime = Date.now();
            const elapsedTime = Math.floor((currentTime - startTime)/1000);
            const timeLeft = start - elapsedTime;
            io.to(data.roomID).emit("timer-started", timeLeft);
        }, 333);
    });
    
    socket.on("stop-timer", (roomID) => {
        clearInterval(timerInterval);
        io.to(roomID).emit("timer-stopped");
    });

    socket.on("stop-conf-timer", (roomID) => {
        clearInterval(timerInterval);
        io.to(roomID).emit("conf-timer-stopped");
    });

    socket.on("answer-found", (data) => {
        clearInterval(timerInterval);
        start = data.start;
        startTime = Date.now();
        timerInterval = setInterval(() => {
            const currentTime = Date.now();
            const elapsedTime = Math.floor((currentTime - startTime)/1000);
            const timeLeft = start - elapsedTime;
            io.to(data.roomID).emit("conf-timer-started", timeLeft);
        }, 333);
    });

    
    socket.on("leave-room", (data) => {
        const {roomID, userID} = data;
        const room1 = room[roomID];
        if(room1){
            room1.occupants -= 1;
            delete room1.users[userID];
            console.log("User left room");
            if(room1.occupants <= 0){
                delete room[roomID];
                console.log("Room deleted");
            }
            socket.leave(roomID);
            io.to(roomID).emit("occupants", {occupants: room1.occupants, users: room1.users});
        }
    });
    
    
    socket.on("disconnect", () => {
        const roomsToLeave = Object.keys(socket.rooms).filter((roomID) => roomID !== socket.id);
        roomsToLeave.forEach((roomID) => {
            const room1 = room[roomID];
            if(room1){
                const userID = Object.keys(room1.users).find(key => socket.rooms[key]);
                room1.occupants -= 1;
                if(userID){
                    delete room1.users[userID];
                }
                if(room1.occupants <= 0){
                    delete room[roomID];
                    console.log("Room deleted");
                }
                io.to(roomID).emit("occupants", {occupants: room1.occupants, users: room1.users});
            }
        });
    });

    socket.on("disconnecting", () => {
        console.log("A user disconnected");
        console.log(room);
    });
});

server.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});