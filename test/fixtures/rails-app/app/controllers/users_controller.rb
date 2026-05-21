class UsersController < ApplicationController
  def index
    @users = User.where(active: true).order(:name)
  end

  def show
    @user = User.find_by(email: params[:email])
  end
end
