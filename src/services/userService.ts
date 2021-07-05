import { prisma } from "./databaseService"
import { isStringValid, isEmailValid } from "./utilityService"
import bcrypt from "bcrypt"
import config from "../config"
import { User } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'

interface UserExport {
    id: number
    username: string
    displayName: string
    profilePictureUrl: string
    description: string
    createdAt: number
    followerCount: number
    followingCount: number
    postCount: number
    isFollowing?: boolean
    isFollowingBack?: boolean
    apiToken?: string
}

async function exportUser(user: User, includeApiToken = false, requester: User = null): Promise<UserExport> {
    let isFollowing = undefined
    let isFollowingBack = undefined

    const followerCount = await prisma.userFollow.count({
        where: {
            followTo: user.id
        }
    })

    const followingCount = await prisma.userFollow.count({
        where: {
            followFrom: user.id
        }
    })

    const postCount = await prisma.post.count({
        where: {
            createdBy: user.id
        }
    })

    if(requester && requester.id !== user.id) {
        const relations = await prisma.userFollow.findMany({
            where: {
                OR: [
                    {
                        followTo: user.id,
                        followFrom: requester.id
                    },
                    {
                        followTo: requester.id,
                        followFrom: user.id
                    }
                ]
            }
        })

        isFollowing = false
        isFollowingBack = false

        for(const relation of relations)
            if(relation.followTo === user.id && relation.followFrom === requester.id)
                isFollowing =  true
            else if(relation.followTo === requester.id && relation.followFrom === user.id)
                isFollowingBack = true
    }

    return exportUserPrepared(user, includeApiToken, followerCount, followingCount, postCount, isFollowing, isFollowingBack)
}

function exportUserPrepared(user: User, includeApiToken: boolean, followerCount: number, followingCount: number, postCount: number, isFollowing: boolean = undefined, isFollowingBack: boolean = undefined): UserExport {
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        profilePictureUrl: user.profilePictureUrl,
        description: user.description,
        createdAt: user.createdAt.getTime(),
        followerCount: followerCount,
        followingCount: followingCount,
        postCount: postCount,
        isFollowing: isFollowing,
        isFollowingBack: isFollowingBack,
        apiToken: includeApiToken ? user.apiToken : undefined
    }
}

/** Creating database entry if email and username are not in use (case insensitive) */
async function registerUser(email: string, username: string, displayName: string, password: string, type: string): Promise<User> {
    const existingEmail = await prisma.user.findFirst({
        where: {
            email: email,
        },
    })

    if (existingEmail != null) throw "email in use"

    const existingUsername = await prisma.user.findFirst({
        where: {
            username: username,
        },
    })

    if (existingUsername != null) throw "username in use"

    const passwordHash = await bcrypt.hash(password, config.passwordSaltRounds)

    const user = await prisma.user.create({
        data: {
            email: email,
            username: username,
            displayName: displayName,
            password: passwordHash,
            type: '',
            apiToken: await generateApiToken()
        },
    })

    return user
}

async function generateApiToken(): Promise<string> {
    const apiToken: string = uuidv4()
    
    const existingUser = await prisma.user.findUnique({
        where: {
            apiToken: apiToken
        }
    })

    if(existingUser) return await generateApiToken()
    return apiToken
}

/** Express middlerware for registering user */
async function registerUserMiddleware(req, res, next) {
    const requiredKeys = ["email", "username", "displayName", "password"]
    const keysAvailable = requiredKeys.every((key) => req.body[key])

    if (!keysAvailable)
        return res.status(500).json({
            error: "missing keys",
        })

    const email: string = req.body.email
    const username: string = req.body.username
    const displayName: string = req.body.displayName
    const password: string = req.body.password

    if (!isEmailValid(email))
        return res.status(500).json({
            error: "invalid email",
        })

    if (!isStringValid(username, 2, 40))
        return res.status(500).json({
            error: "invalid username",
        })

    if (!isStringValid(displayName, 1, 120))
        return res.status(500).json({
            error: "invalid displayName",
        })

    if (!isStringValid(password, 8, 200))
        return res.status(500).json({
            error: "invalid password",
        })

    try {
        const user = await registerUser(email, username, displayName, password, '')

        req.user = user
        next()
    } catch (exception) {
        console.log(exception)
        return res.status(500).json({
            error: exception
        })
    }
}

/** Retrieving user and validating password if user exists */
async function loginUser(emailOrUsername: string, password: string): Promise<User> {

    const user = await prisma.user.findFirst({
        where: {
            OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
        },
    })

    if (user == null) throw "unknown user"

    const passwordValid: boolean = await bcrypt.compare(password, user.password)

    if (!passwordValid) throw "invalid password"

    return user
}

/** express middleware for logging in user */
async function loginUserMiddleware(req, res, next) {
    const requiredKeys = ["username", "password"]
    const keysAvailable = requiredKeys.every((key) => req.body[key])

    if (!keysAvailable)
        return res.status(500).json({
            error: "missing keys",
        })

    const username: string = req.body.username
    const password: string = req.body.password

    try {
        const user = await loginUser(username, password)

        req.user = user
        next()
    } catch (exception) {
        return res.status(500).json({
            error: exception,
        })
    }
}

async function validateApiToken(apiToken: string): Promise<User | null> {
    return await prisma.user.findUnique({
        where: {
            apiToken: apiToken
        }
    })
}

async function authenticateMiddleware(req, res, next) {
    if(!req.headers.authorization)
        return res.status(403).json({
            error: "missing credentials"
        })

    const authorization: string = req.headers.authorization

    if(!authorization.startsWith('Bearer '))
        return res.status(403).json({
            error: "invalid credentials"
        })

    const user = await validateApiToken(authorization.replace('Bearer ', ''))

    if(!user)
        return res.status(403).json({
            error: "invalid credentials"
        })
    else {
        req.user = user
        next()
    }
}

async function getAuthenticatedUserMiddleware(req, res, next) {
    
    if(!req.headers.authorization) return next();

    const authorization: string = req.headers.authorization

    if(!authorization.startsWith('Bearer '))
        return res.status(403).json({
            error: "invalid credentials"
        })

    const user = await validateApiToken(authorization.replace('Bearer ', ''))

    if(!user)
        return res.status(403).json({
            error: "invalid credentials"
        })
    else {
        req.user = user
        next()
    }
}

async function getUser(id: number): Promise<User> {
    return await prisma.user.findUnique({
        where: {
            id: id
        }
    })
}

async function getUserMiddleware(req, res, next) {
    const id: string = req.params.id

    try {
        const user = await getUser(parseInt(id))

        if(!user)
            return res.status(404).json({
                error: "unknown user"
            })

        req.data = user
        next()
    } catch (exception) {
        console.log(exception)
        return res.status(500).json({
            error: exception
        })
    }
}

async function followUnfollowUser(follow: boolean, followFrom: User, followTo: User) {
    if(follow)
        await prisma.userFollow.upsert({
            where: {
                followFrom_followTo: {
                    followFrom: followFrom.id,
                    followTo: followTo.id
                }
            },
            update: {},
            create: {
                followFrom: followFrom.id,
                followTo: followTo.id
            }
        })
    else
        await prisma.userFollow.deleteMany({
            where: {
                AND: {
                    followFrom: followFrom.id,
                    followTo: followTo.id
                }
            }
        })
}

async function followUnfollowUserMiddleware(follow: boolean, req, res, next) {
    try {
        const followFrom: User = req.user
        const followTo: User = req.data

        if(followFrom.id === followTo.id)
            return res.status(500).json({
                error: "user cannot follow self"
            })

        await followUnfollowUser(follow, followFrom, followTo)
        req.data = followTo
        next()
    } catch (exception) {
        console.log(exception)
        return res.status(500).json({
            error: exception
        })
    }
}

async function followUserMiddleware(req, res, next) {
    followUnfollowUserMiddleware(true, req, res, next)
}

async function unfollowUserMiddleware(req, res, next) {
    followUnfollowUserMiddleware(false, req, res, next)
}

export {
    exportUser,
    exportUserPrepared,
    registerUser,
    registerUserMiddleware,
    loginUser,
    loginUserMiddleware,
    authenticateMiddleware,
    getAuthenticatedUserMiddleware,
    getUser,
    getUserMiddleware,
    followUnfollowUser,
    followUserMiddleware,
    unfollowUserMiddleware
}

export type { UserExport };